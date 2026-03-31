import { WebSocketServer, WebSocket } from "ws";
import { Server, IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import Database from "better-sqlite3";
import jwt from "jsonwebtoken";
import { v7 as uuidv7 } from "uuid";
import {
  WsMessage,
  WsRegistryEntry,
  GameSender,
  GameOrchestrator,
  UserRow,
  JwtPayload,
  ParticipantRow,
  GameRow,
  HeartbeatOptions,
} from "../types/index.ts";
import { findById } from "../repositories/userRepository.ts";
import { logInfo, logWarn, logError } from "../utils/logger.ts";
import logger from "../config/logger.ts";
import { createGameOrchestrator } from "../game/gameOrchestrator.ts";
import { findActiveGame } from "../repositories/gameanswerRepository.ts";
import { findParticipantsByGameId } from "../repositories/gameRepository.ts";
import { findSoundById } from "../repositories/soundRepository.ts";
import { RateLimiter } from "../middlewares/rateLimiter.ts";
import { startHeartbeat, stopHeartbeat } from "./ws-heartbeat.ts";
import { SYSTEM_SOUNDS } from "../constants/systemSounds.ts";
import { broadcastSystemSoundToBuzzers, sendSystemSound } from "../utils/soundUtils.ts";
import { syncGameStateOnConnect } from "../game/gameSync.ts";
import { scheduleTokenTimers, clearTokenTimers, handleAuthRefresh } from "./tokenRefreshHandler.ts";
import { runWithCorrelationId } from "../utils/correlationStore.ts";

export const MAX_BUZZERS = 10;
export const AUTH_TIMEOUT_MS = 60_000;
export const WS_RATE_LIMIT_CONNECTIONS = 15;
export const WS_RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute

export const WS_CLOSE_INVALID_TOKEN = 4001;
export const WS_CLOSE_TOKEN_EXPIRED = 4002;
export const WS_CLOSE_AUTH_TIMEOUT = 4003;
export const WS_CLOSE_SESSION_REPLACED = 4004;

/** Message types reserved for admin (game master). */
const ADMIN_MESSAGE_TYPES = new Set([
  "trigger_title", "trigger_choices", "trigger_correction", "trigger_next_question",
  "validate_answer", "invalidate_answer", "trigger_intermediate_ranking",
  "request_game_state",
]);

/** Message types reserved for buzzers (players). */
const BUZZER_MESSAGE_TYPES = new Set(["answer", "buzz"]);

interface AttachWebSocketOptions {
  authTimeoutMs?: number;
  wsRateLimitConnections?: number;
  wsRateLimitWindowMs?: number;
  orchestratorOptions?: Record<string, unknown>;
  heartbeatOptions?: HeartbeatOptions;
  tokenTimerOptions?: { setTimeoutFn?: typeof setTimeout; clearTimeoutFn?: typeof clearTimeout };
  serverBaseUrl?: string;
}

interface ExtendedWebSocketServer extends WebSocketServer {
  _notifyGameStateChange: (newStatus: string) => void;
  _notifyGameDeleted: (gameId: string) => void;
}

/**
 * Attaches a WebSocket server to the existing HTTP server on the /ws endpoint.
 */
export function attachWebSocket(
  httpServer: Server,
  db: Database.Database,
  jwtSecret: string,
  {
    authTimeoutMs = AUTH_TIMEOUT_MS,
    wsRateLimitConnections = WS_RATE_LIMIT_CONNECTIONS,
    wsRateLimitWindowMs = WS_RATE_LIMIT_WINDOW_MS,
    orchestratorOptions = {},
    heartbeatOptions = {},
    tokenTimerOptions = {},
    serverBaseUrl = "",
  }: AttachWebSocketOptions = {},
): ExtendedWebSocketServer {
  const wss = new WebSocketServer({ noServer: true }) as ExtendedWebSocketServer;

  // registry: Map<sub, { ws, role, username, connectedAt }>
  const registry = new Map<string, WsRegistryEntry>();

  // Rate limiter for WebSocket connection attempts (per IP)
  const wsRateLimiter = new RateLimiter(wsRateLimitConnections, wsRateLimitWindowMs);

  // ── Buzzer-order helpers ─────────────────────────────────────────────────

  /**
   * Extracts the 1-based buzzer order from a username like "quiz_buzzer_01".
   * Returns null if the username doesn't match the expected pattern.
   */
  function extractBuzzerOrder(username: string): number | null {
    const match = username.match(/^quiz_buzzer_(\d+)$/i);
    if (!match) return null;
    const order = parseInt(match[1], 10);
    return order >= 1 && order <= MAX_BUZZERS ? order : null;
  }

  /**
   * Finds the registry entry for the buzzer assigned to the given participant order.
   * Primary: buzzer quiz_buzzer_XX maps to participant order XX.
   * Fallback: match buzzer username against participant name (case-insensitive).
   */
  function findBuzzerEntryByOrder(participantOrder: number): WsRegistryEntry | undefined {
    // Primary: quiz_buzzer_XX -> order XX
    for (const entry of registry.values()) {
      if (entry.role === "buzzer" && extractBuzzerOrder(entry.username) === participantOrder) {
        return entry;
      }
    }

    // Fallback: match by participant name
    const game = findActiveGame(db);
    if (!game) return undefined;

    const participants = findParticipantsByGameId(db, game.GAM_ID) as ParticipantRow[];
    const participant = participants.find((p) => p.GPA_ORDER === participantOrder);
    if (!participant) return undefined;

    const targetName = participant.GPA_NAME.toLowerCase();
    for (const entry of registry.values()) {
      if (entry.role === "buzzer" && entry.username.toLowerCase() === targetName) {
        return entry;
      }
    }
    return undefined;
  }

  // ── Sender helpers for the orchestrator ──────────────────────────────────

  function sendJson(ws: WebSocket, msg: WsMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify(msg);
      // CA-26: log messages WebSocket sortants en DEBUG
      logger.debug({ event: "WEBSOCKET_MESSAGE_SENT", type: msg.type, raw: payload });
      ws.send(payload);
    }
  }

  const sender: GameSender = {
    /** Broadcast a message to ALL connected clients (admin + buzzers). */
    broadcast(msg: WsMessage): void {
      for (const entry of registry.values()) {
        sendJson(entry.ws, msg);
      }
    },

    /** Send a message to the connected admin, if any. */
    sendToAdmin(msg: WsMessage): void {
      for (const entry of registry.values()) {
        if (entry.role === "admin") {
          sendJson(entry.ws, msg);
          break;
        }
      }
    },

    /**
     * Send a message to the buzzer assigned to the given participant order.
     * Buzzer quiz_buzzer_XX is assigned to participant order XX.
     */
    sendToBuzzer(participantOrder: number, msg: WsMessage): void {
      const entry = findBuzzerEntryByOrder(participantOrder);
      if (entry) {
        sendJson(entry.ws, msg);
      }
    },

    /**
     * Send a system sound to a specific buzzer (US-018 auto-triggers).
     * Non-blocking: errors are caught and logged.
     */
    sendSystemSoundToBuzzer(participantOrder: number, soundId: string): void {
      const entry = findBuzzerEntryByOrder(participantOrder);
      if (entry) {
        sendSystemSound(entry.ws, soundId);
      }
    },

    /**
     * Broadcast a system sound to all connected buzzers (US-018 auto-triggers).
     */
    broadcastSystemSound(soundId: string): void {
      broadcastSystemSoundToBuzzers(registry, soundId, "auto");
    },
  };

  // ── Orchestrator ──────────────────────────────────────────────────────────

  const orchestrator = createGameOrchestrator(db, sender, orchestratorOptions as { persistFn?: undefined; retryOptions?: undefined });

  // Tracks when the current question's choices were shown (used to compute timeMs for answers)
  let questionStartedAtMs: number | null = null;

  /** OCP: registre des handlers admin — ajouter un type = ajouter une entrée */
  const adminMessageHandlers: Record<string, () => ReturnType<typeof orchestrator.handleTriggerTitle> | ReturnType<typeof orchestrator.handleTriggerCorrection>> = {
    trigger_title: () => {
      const result = orchestrator.handleTriggerTitle();
      if (result.ok) questionStartedAtMs = null;
      return result;
    },
    trigger_choices: () => {
      const result = orchestrator.handleTriggerChoices();
      if (result.ok) questionStartedAtMs = Date.now();
      return result;
    },
    trigger_correction: () => orchestrator.handleTriggerCorrection(),
    trigger_next_question: () => orchestrator.handleTriggerNextQuestion(),
    validate_answer: () => orchestrator.handleValidateAnswer(),
    invalidate_answer: () => orchestrator.handleInvalidateAnswer(),
    trigger_intermediate_ranking: () => orchestrator.handleTriggerIntermediateRanking(),
  };

  // ── Game message handler (post-auth) ─────────────────────────────────────

  /**
   * Resolves the participant order for a buzzer.
   * Primary: buzzer quiz_buzzer_XX maps to participant order XX.
   * Fallback: match username against participant name (case-insensitive).
   */
  function resolveParticipantOrder(username: string): number | null {
    const game = findActiveGame(db);
    if (!game) return null;

    const participants = findParticipantsByGameId(db, game.GAM_ID) as ParticipantRow[];

    // Primary: quiz_buzzer_XX -> participant order XX
    const buzzerOrder = extractBuzzerOrder(username);
    if (buzzerOrder !== null) {
      const match = participants.find((p) => p.GPA_ORDER === buzzerOrder);
      if (match) return match.GPA_ORDER;
    }

    // Fallback: match by participant name
    const matchByName = participants.find(
      (p) => p.GPA_NAME.toLowerCase() === username.toLowerCase()
    );
    return matchByName ? matchByName.GPA_ORDER : null;
  }

  /**
   * Handles a game-related message received from an authenticated client.
   * Enforces CA-37, CA-38, CA-40, CA-41, CA-42.
   */
  async function handleGameMessage(data: Buffer | string, sub: string, ws: WebSocket): Promise<void> {
    const entry = registry.get(sub);
    if (!entry) return;

    const { role, username } = entry;

    // CA-41: silently ignore invalid JSON, log WARN
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      logWarn("GAME_MESSAGE_IGNORED", { reason: "Invalid JSON", sub });
      return;
    }

    // CA-40: silently ignore unknown or missing type, log WARN
    if (!msg || typeof msg.type !== "string") {
      logWarn("GAME_MESSAGE_IGNORED", { reason: "Unknown type", sub });
      return;
    }

    const { type } = msg;

    // CA-37: buzzer sending admin-only message -> ignore, WARN
    if (role === "buzzer" && ADMIN_MESSAGE_TYPES.has(type as string)) {
      logWarn("GAME_MESSAGE_IGNORED", { reason: "Role not allowed to send this message type", role, type, sub });
      return;
    }

    // CA-38: admin sending buzzer-only message -> ignore, WARN
    if (role === "admin" && BUZZER_MESSAGE_TYPES.has(type as string)) {
      logWarn("GAME_MESSAGE_IGNORED", { reason: "Role not allowed to send this message type", role, type, sub });
      return;
    }

    // Handle request_game_state: admin requests a fresh game_state_sync
    if (type === "request_game_state") {
      if (role === "buzzer") {
        logWarn("GAME_MESSAGE_IGNORED", { reason: "Role not allowed to send this message type", role, type, sub });
        return;
      }
      syncGameStateOnConnect(ws, "admin", null, db, {
        getTimerInfo: () => orchestrator.getTimerInfo(),
        connectedBuzzerUsernames: getConnectedBuzzerUsernames(),
      });
      return;
    }

    // Handle play_sound (US-017 CA-22 to CA-30)
    if (type === "play_sound") {
      // CA-26: buzzer cannot send play_sound
      if (role === "buzzer") {
        logWarn("GAME_MESSAGE_IGNORED", { reason: "Role not allowed to send this message type", role, type, sub });
        return;
      }
      handlePlaySound(msg, ws);
      return;
    }

    // Handle trigger_system_sound (US-018 CA-10 to CA-16)
    if (type === "trigger_system_sound") {
      // CA-15: buzzer cannot trigger system sounds -> ignore silently
      if (role === "buzzer") {
        logWarn("GAME_MESSAGE_IGNORED", { reason: "Role not allowed to send this message type", role, type, sub });
        return;
      }
      handleTriggerSystemSound(msg, ws);
      return;
    }

    // CA-40: fully unknown type (neither admin nor buzzer message) -> ignore, WARN
    if (!ADMIN_MESSAGE_TYPES.has(type as string) && !BUZZER_MESSAGE_TYPES.has(type as string)) {
      logWarn("GAME_MESSAGE_IGNORED", { reason: "Unknown type", type, sub });
      return;
    }

    // ── Admin messages (OCP: handler registry) ────────────────────────────

    if (role === "admin") {
      const handler = adminMessageHandlers[type as string];
      if (!handler) return;

      const result = await handler();

      if (result && !result.ok) {
        sendJson(ws, {
          type: "error",
          code: result.error!.code,
          message: result.error!.message,
        });
      }
      return;
    }

    // ── Buzzer messages ─────────────────────────────────────────────────────

    if (role === "buzzer") {
      if (type === "buzz") {
        // SPEED: handle buzz
        const participantOrder = resolveParticipantOrder(username);
        if (participantOrder === null) {
          logWarn("GAME_BUZZ_IGNORED", { reason: "Not a participant", username, sub });
          return;
        }
        const result = orchestrator.handleBuzz(sub, username, participantOrder);
        if (!result.accepted) {
          logWarn("GAME_BUZZ_IGNORED", {
            reason: result.reason ?? "Unknown",
            participant_order: participantOrder,
            sub,
          });
        }
        return;
      }

      // MCQ: handle answer
      // CA-42: validate required fields for 'answer'
      if (typeof msg.value !== "string") {
        sendJson(ws, {
          type: "error",
          code: "INVALID_MESSAGE",
          message: "Missing or invalid 'value' field.",
        });
        return;
      }

      const participantOrder = resolveParticipantOrder(username);
      // CA-21: participant not in game -> orchestrator will reject via UNKNOWN_PARTICIPANT
      const timeMs = questionStartedAtMs ? Date.now() - questionStartedAtMs : 0;

      const result = orchestrator.handleAnswer(
        participantOrder ?? -1,
        msg.value as string,
        timeMs
      );

      if (!result.accepted) {
        logWarn("GAME_ANSWER_IGNORED", {
          reason: result.reason ?? "Unknown",
          participant_order: participantOrder,
          sub,
        });
      }
    }
  }

  // ── Play sound handler (US-017) ──────────────────────────────────────────

  /**
   * Handles the play_sound message from admin (CA-22 to CA-30).
   */
  function handlePlaySound(msg: Record<string, unknown>, ws: WebSocket): void {
    // CA-28: Validate sound_id
    if (!msg.sound_id || typeof msg.sound_id !== "string") {
      sendJson(ws, {
        type: "error",
        code: "INVALID_MESSAGE",
        message: "Missing or invalid field: sound_id.",
      });
      return;
    }

    // CA-25: Check sound exists in DB
    const sound = findSoundById(db, msg.sound_id as string);
    if (!sound) {
      sendJson(ws, {
        type: "error",
        code: "SOUND_NOT_FOUND",
        message: "The requested sound was not found.",
      });
      return;
    }

    // Build absolute URL (CA-29)
    const absoluteUrl = `${serverBaseUrl}/uploads/sounds/${sound.SND_FILENAME}`;

    const playSoundMsg: WsMessage = {
      type: "play_sound_url",
      sound_id: msg.sound_id,
      url: absoluteUrl,
    };

    // Resolve targets
    const targets = msg.targets as string[] | undefined;
    const hasTargets = Array.isArray(targets) && targets.length > 0;

    // Get all connected buzzers
    const connectedBuzzers: WsRegistryEntry[] = [];
    for (const entry of registry.values()) {
      if (entry.role === "buzzer") {
        connectedBuzzers.push(entry);
      }
    }

    // CA-30: No buzzers connected
    if (connectedBuzzers.length === 0) {
      logInfo("SOUND_NO_TARGETS", { sound_id: msg.sound_id as string });
      logInfo("SOUND_PLAYED", {
        sound_id: msg.sound_id as string,
        targets_requested: hasTargets ? targets!.length : 0,
        targets_reached: 0,
      });
      return;
    }

    // CA-23: No targets or empty array -> broadcast to all buzzers
    if (!hasTargets) {
      for (const entry of connectedBuzzers) {
        sendJson(entry.ws, playSoundMsg);
      }
      logInfo("SOUND_PLAYED", {
        sound_id: msg.sound_id as string,
        targets_requested: 0,
        targets_reached: connectedBuzzers.length,
      });
      return;
    }

    // CA-22: Targeted delivery
    let targetsReached = 0;
    for (const username of targets!) {
      const targetEntry = connectedBuzzers.find(
        (e) => e.username.toLowerCase() === username.toLowerCase()
      );
      if (targetEntry) {
        sendJson(targetEntry.ws, playSoundMsg);
        targetsReached++;
      } else {
        // CA-24: Target not connected -> warn
        logWarn("SOUND_TARGET_NOT_CONNECTED", {
          sound_id: msg.sound_id as string,
          username,
        });
      }
    }

    logInfo("SOUND_PLAYED", {
      sound_id: msg.sound_id as string,
      targets_requested: targets!.length,
      targets_reached: targetsReached,
    });
  }

  // ── Trigger system sound handler (US-018 CA-10 to CA-14) ───────────────────

  /**
   * Handles the trigger_system_sound message from admin.
   */
  function handleTriggerSystemSound(msg: Record<string, unknown>, ws: WebSocket): void {
    // CA-12: sound_id absent or empty
    if (!msg.sound_id || typeof msg.sound_id !== "string") {
      sendJson(ws, {
        type: "error",
        code: "INVALID_MESSAGE",
        message: "Missing or invalid field: sound_id.",
      });
      return;
    }

    // CA-13: sound_id not in catalogue
    if (!SYSTEM_SOUNDS.has(msg.sound_id as string)) {
      sendJson(ws, {
        type: "error",
        code: "UNKNOWN_SYSTEM_SOUND",
        message: "Unknown system sound identifier.",
      });
      return;
    }

    const targets = msg.targets as string[] | undefined;
    const hasTargets = Array.isArray(targets) && targets.length > 0;

    // CA-10: No targets -> broadcast to all buzzers
    if (!hasTargets) {
      broadcastSystemSoundToBuzzers(registry, msg.sound_id as string, "manual");
      return;
    }

    // CA-11: Targeted delivery
    const connectedBuzzers: WsRegistryEntry[] = [];
    for (const entry of registry.values()) {
      if (entry.role === "buzzer") {
        connectedBuzzers.push(entry);
      }
    }

    let targetsReached = 0;
    for (const username of targets!) {
      const targetEntry = connectedBuzzers.find(
        (e) => e.username.toLowerCase() === username.toLowerCase()
      );
      if (targetEntry) {
        sendSystemSound(targetEntry.ws, msg.sound_id as string);
        targetsReached++;
      } else {
        // CA-14: target not connected -> warn
        logWarn("SYSTEM_SOUND_TARGET_NOT_CONNECTED", {
          sound_id: msg.sound_id as string,
          username,
        });
      }
    }

    if (targetsReached === 0) {
      logInfo("SYSTEM_SOUND_NO_TARGETS", { sound_id: msg.sound_id as string, trigger: "manual" });
    } else {
      logInfo("SYSTEM_SOUND_SENT", {
        sound_id: msg.sound_id as string,
        trigger: "manual",
        targets_reached: targetsReached,
      });
    }
  }

  // ── WebSocket lifecycle ───────────────────────────────────────────────────

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url!, `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    // Rate limit WebSocket connection attempts per IP
    const ip = req.socket.remoteAddress || "unknown";
    const rateLimitCheck = wsRateLimiter.check(ip);
    if (!rateLimitCheck.allowed) {
      logWarn("WEBSOCKET_RATE_LIMITED", { ip, limit: wsRateLimitConnections, windowSeconds: wsRateLimitWindowMs / 1000 });
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const ip = req.socket.remoteAddress || "unknown";
    logInfo("WEBSOCKET_CONNECTED", { ip });

    // sub of the authenticated user (null until authenticated)
    let sub: string | null = null;

    const authTimer = setTimeout(() => {
      logWarn("WEBSOCKET_AUTH_FAILED", { reason: "Authentication timeout.", ip });
      ws.close(WS_CLOSE_AUTH_TIMEOUT, "Authentication timeout.");
    }, authTimeoutMs);

    ws.on("message", (data: Buffer | string) => {
      // Post-auth: route auth_refresh or game message handler
      if (sub !== null) {
        // CA-23: chaque message WS reçoit un correlation_id UUIDv7 unique
        const wsCorrelationId = uuidv7();
        const entry = registry.get(sub);
        const rawData = data.toString();

        // CA-25: log du message entrant en DEBUG
        logger.debug({
          event: "WEBSOCKET_MESSAGE_RECEIVED",
          raw: rawData,
          username: entry?.username,
          correlation_id: wsCorrelationId,
        });

        // CA-24: propager le correlation_id dans le contexte de traitement
        runWithCorrelationId(wsCorrelationId, () => {
          // CA-20: parse JSON; ignore invalid JSON silently with WARN
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(rawData);
          } catch {
            logWarn("GAME_MESSAGE_IGNORED", { reason: "Invalid JSON", sub });
            return;
          }

          // US-021: handle auth_refresh on existing connection
          if (msg && msg.type === "auth_refresh") {
            try {
              handleAuthRefresh(msg as { type: string; token?: string }, ws, sub!, registry, jwtSecret, tokenTimerOptions);
            } catch (err: unknown) {
              logError("INTERNAL_ERROR", { message: (err as Error).message });
              ws.close(1011, "Internal server error.");
            }
            return;
          }

          handleGameMessage(data, sub!, ws);
        });
        return;
      }

      // Cancel auth timer on first message (CA-9)
      clearTimeout(authTimer);

      // Parse JSON (CA-10)
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        logWarn("WEBSOCKET_AUTH_FAILED", { reason: "Invalid token.", ip });
        ws.close(WS_CLOSE_INVALID_TOKEN, "Invalid token.");
        return;
      }

      // Validate message format (CA-11)
      if (!msg || msg.type !== "auth" || typeof msg.token !== "string") {
        logWarn("WEBSOCKET_AUTH_FAILED", { reason: "Invalid token.", ip });
        ws.close(WS_CLOSE_INVALID_TOKEN, "Invalid token.");
        return;
      }

      // Verify JWT (CA-5, CA-7, CA-8)
      let decoded: JwtPayload;
      try {
        decoded = jwt.verify(msg.token as string, jwtSecret, { algorithms: ["HS256"] }) as JwtPayload;
      } catch (err: unknown) {
        if ((err as Error).name === "TokenExpiredError") {
          logWarn("WEBSOCKET_AUTH_FAILED", { reason: "Token expired.", ip });
          ws.close(WS_CLOSE_TOKEN_EXPIRED, "Token expired.");
        } else {
          logWarn("WEBSOCKET_AUTH_FAILED", { reason: "Invalid token.", ip });
          ws.close(WS_CLOSE_INVALID_TOKEN, "Invalid token.");
        }
        return;
      }

      // Validate required claims (CA-5)
      const tokenSub = decoded.sub;
      const tokenRole = decoded.role;
      if (!tokenSub || !tokenRole) {
        logWarn("WEBSOCKET_AUTH_FAILED", { reason: "Invalid token.", ip });
        ws.close(WS_CLOSE_INVALID_TOKEN, "Invalid token.");
        return;
      }

      // Resolve username from DB (CA-7 — user might have been deleted)
      let user: UserRow | undefined;
      try {
        user = findById(db, tokenSub);
      } catch (err: unknown) {
        logError("INTERNAL_ERROR", { message: (err as Error).message, ip });
        ws.close(1011, "Internal server error.");
        return;
      }

      if (!user) {
        logWarn("WEBSOCKET_AUTH_FAILED", { reason: "Invalid token.", ip });
        ws.close(WS_CLOSE_INVALID_TOKEN, "Invalid token.");
        return;
      }

      // Helper: close and remove an existing session from the registry
      function replaceExistingSession(existingSub: string): void {
        const existing = registry.get(existingSub)!;
        clearTokenTimers(existing, tokenTimerOptions);
        stopHeartbeat(existing.ws, heartbeatOptions);
        registry.delete(existingSub);
        existing.ws.close(WS_CLOSE_SESSION_REPLACED, "Session replaced.");
      }

      // Handle session replacement for same sub (CA-13, CA-17)
      if (registry.has(tokenSub)) {
        replaceExistingSession(tokenSub);
      } else {
        // Enforce role-specific connection limits
        if (tokenRole === "buzzer" && buzzersConnected() >= MAX_BUZZERS) {
          logWarn("WEBSOCKET_AUTH_FAILED", { reason: "Invalid token.", ip });
          ws.close(WS_CLOSE_INVALID_TOKEN, "Invalid token.");
          return;
        }

        // CA-17: replace existing admin with different sub
        if (tokenRole === "admin" && adminConnected() >= 1) {
          for (const [existingSub, entry] of registry) {
            if (entry.role === "admin") {
              replaceExistingSession(existingSub);
              break;
            }
          }
        }
      }

      // Register new connection
      sub = tokenSub;
      registry.set(sub, {
        ws,
        role: tokenRole,
        username: user.USR_USERNAME,
        connectedAt: new Date().toISOString(),
      });

      // Calculate remaining token expiration time (US-003)
      const expiresIn = decoded.exp - Math.floor(Date.now() / 1000);

      // Send auth_success (CA-6)
      ws.send(JSON.stringify({
        type: "auth_success",
        role: tokenRole,
        username: user.USR_USERNAME,
        expires_in: expiresIn,
      }));

      // US-021: Schedule token expiration timers
      scheduleTokenTimers(ws, registry.get(sub)!, decoded.exp, registry, sub, tokenTimerOptions);

      // Notify admin when a buzzer connects
      if (tokenRole === "buzzer") {
        sender.sendToAdmin({
          type: "buzzer_connected",
          username: user.USR_USERNAME,
        });
      }

      // US-019: Synchronisation de l'état de jeu après auth_success
      syncGameStateOnConnect(ws, tokenRole, user.USR_USERNAME, db, {
        getTimerInfo: () => orchestrator.getTimerInfo(),
        connectedBuzzerUsernames: getConnectedBuzzerUsernames(),
      });

      // Start heartbeat after successful authentication (US-015 CA-1)
      startHeartbeat(ws, { username: user.USR_USERNAME, role: tokenRole }, { ...heartbeatOptions, ip });

      // Log successful authentication (CA-19)
      logInfo("WEBSOCKET_AUTHENTICATED", {
        username: user.USR_USERNAME,
        role: tokenRole,
        ip,
        ...connectedSummary(),
      });
    });

    ws.on("close", () => {
      clearTimeout(authTimer);

      // Stop heartbeat timer (US-015 CA-3, CA-11)
      stopHeartbeat(ws, heartbeatOptions);

      // Only log disconnect if this ws is still the registered connection (CA-21)
      if (sub !== null) {
        const entry = registry.get(sub);
        if (entry && entry.ws === ws) {
          // US-021 CA-4, CA-9: clear token timers on disconnect
          clearTokenTimers(entry, tokenTimerOptions);

          // Notify admin when a buzzer disconnects
          if (entry.role === "buzzer") {
            sender.sendToAdmin({
              type: "buzzer_disconnected",
              username: entry.username,
            });
          }

          registry.delete(sub);
          logInfo("WEBSOCKET_DISCONNECTED", {
            username: entry.username,
            role: entry.role,
            ip,
            ...connectedSummary(),
          });
        }
      }
    });

    ws.on("error", (err: Error) => {
      logError("INTERNAL_ERROR", { message: err.message, ip });
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1011, "Internal server error.");
      }
    });
  });

  function getConnectedBuzzerUsernames(): string[] {
    return [...registry.values()]
      .filter((c) => c.role === "buzzer")
      .map((c) => c.username);
  }

  function buzzersConnected(): number {
    return [...registry.values()].filter((c) => c.role === "buzzer").length;
  }

  function adminConnected(): number {
    return [...registry.values()].filter((c) => c.role === "admin").length;
  }

  function connectedSummary(): { buzzers_connected: number; buzzers_max: number; admin_connected: number } {
    return {
      buzzers_connected: buzzersConnected(),
      buzzers_max: MAX_BUZZERS,
      admin_connected: adminConnected(),
    };
  }

  // Expose notification function for game state changes (CA-7, CA-8)
  wss._notifyGameStateChange = (newStatus: string) => {
    if (newStatus === "OPEN") {
      broadcastSystemSoundToBuzzers(registry, "GAME_START", "auto");
    } else if (newStatus === "COMPLETED") {
      broadcastSystemSoundToBuzzers(registry, "GAME_END", "auto");
    }
  };

  // Point de vigilance US-010: nettoyage des ressources en mémoire avant suppression SQL
  wss._notifyGameDeleted = (_gameId: string) => {
    orchestrator.cleanupGameState();
  };

  return wss;
}
