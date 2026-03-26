import { WebSocketServer, WebSocket } from "ws";
import jwt from "jsonwebtoken";
import { findById } from "../repositories/userRepository.js";
import { logInfo, logWarn, logError } from "../utils/logger.js";
import { createGameOrchestrator } from "../game/gameOrchestrator.js";
import { findActiveGame } from "../repositories/gameanswerRepository.js";
import { findParticipantsByGameId } from "../repositories/gameRepository.js";
import { RateLimiter } from "../middlewares/rateLimiter.js";

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
]);

/** Message types reserved for buzzers (players). */
const BUZZER_MESSAGE_TYPES = new Set(["answer", "buzz"]);

/**
 * Attaches a WebSocket server to the existing HTTP server on the /ws endpoint.
 *
 * @param {import("node:http").Server} httpServer
 * @param {import("better-sqlite3").Database} db
 * @param {string} jwtSecret
 * @param {Object} [opts]
 * @param {number} [opts.authTimeoutMs] - Auth timeout in ms (injectable for tests)
 * @param {number} [opts.wsRateLimitConnections] - Max WebSocket connections per window (injectable for tests)
 * @param {number} [opts.wsRateLimitWindowMs] - Rate limit window in ms (injectable for tests)
 * @param {Object} [opts.orchestratorOptions] - Options forwarded to createGameOrchestrator (injectable for tests)
 * @returns {WebSocketServer}
 */
export function attachWebSocket(httpServer, db, jwtSecret, {
  authTimeoutMs = AUTH_TIMEOUT_MS,
  wsRateLimitConnections = WS_RATE_LIMIT_CONNECTIONS,
  wsRateLimitWindowMs = WS_RATE_LIMIT_WINDOW_MS,
  orchestratorOptions = {},
} = {}) {
  const wss = new WebSocketServer({ noServer: true });

  // registry: Map<sub, { ws, role, username, connectedAt }>
  const registry = new Map();

  // Rate limiter for WebSocket connection attempts (per IP)
  const wsRateLimiter = new RateLimiter(wsRateLimitConnections, wsRateLimitWindowMs);

  // ── Sender helpers for the orchestrator ──────────────────────────────────

  function sendJson(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  const sender = {
    /** Broadcast a message to ALL connected clients (admin + buzzers). */
    broadcast(msg) {
      for (const entry of registry.values()) {
        sendJson(entry.ws, msg);
      }
    },

    /** Send a message to the connected admin, if any. */
    sendToAdmin(msg) {
      for (const entry of registry.values()) {
        if (entry.role === "admin") {
          sendJson(entry.ws, msg);
          break;
        }
      }
    },

    /**
     * Send a message to the buzzer whose participant name matches the given order.
     * Resolves participant name from the active game, then finds the buzzer
     * whose username matches that name (case-insensitive).
     *
     * @param {number} participantOrder - 1-based order in T_GAME_PARTICIPANT_GPA
     * @param {Object} msg
     */
    sendToBuzzer(participantOrder, msg) {
      const game = findActiveGame(db);
      if (!game) return;

      const participants = findParticipantsByGameId(db, game.GAM_ID);
      const participant = participants.find((p) => p.GPA_ORDER === participantOrder);
      if (!participant) return;

      const targetName = participant.GPA_NAME.toLowerCase();
      for (const entry of registry.values()) {
        if (entry.role === "buzzer" && entry.username.toLowerCase() === targetName) {
          sendJson(entry.ws, msg);
          break;
        }
      }
    },
  };

  // ── Orchestrator ──────────────────────────────────────────────────────────

  const orchestrator = createGameOrchestrator(db, sender, orchestratorOptions);

  // CA-36: recover any interrupted game on startup
  orchestrator.recoverFromCrash();

  // Tracks when the current question's choices were shown (used to compute timeMs for answers)
  let questionStartedAtMs = null;

  // ── Game message handler (post-auth) ─────────────────────────────────────

  /**
   * Resolves the participant order for a buzzer by matching its username
   * against the active game's participants.
   *
   * @param {string} username
   * @returns {number|null}
   */
  function resolveParticipantOrder(username) {
    const game = findActiveGame(db);
    if (!game) return null;

    const participants = findParticipantsByGameId(db, game.GAM_ID);
    const match = participants.find(
      (p) => p.GPA_NAME.toLowerCase() === username.toLowerCase()
    );
    return match ? match.GPA_ORDER : null;
  }

  /**
   * Handles a game-related message received from an authenticated client.
   * Enforces CA-37, CA-38, CA-40, CA-41, CA-42.
   *
   * @param {Buffer|string} data
   * @param {string} sub
   * @param {import("ws").WebSocket} ws
   */
  async function handleGameMessage(data, sub, ws) {
    const entry = registry.get(sub);
    if (!entry) return;

    const { role, username } = entry;

    // CA-41: silently ignore invalid JSON, log WARN
    let msg;
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

    // CA-37: buzzer sending admin-only message → ignore, WARN
    if (role === "buzzer" && ADMIN_MESSAGE_TYPES.has(type)) {
      logWarn("GAME_MESSAGE_IGNORED", { reason: "Role not allowed to send this message type", role, type, sub });
      return;
    }

    // CA-38: admin sending buzzer-only message → ignore, WARN
    if (role === "admin" && BUZZER_MESSAGE_TYPES.has(type)) {
      logWarn("GAME_MESSAGE_IGNORED", { reason: "Role not allowed to send this message type", role, type, sub });
      return;
    }

    // CA-40: fully unknown type (neither admin nor buzzer message) → ignore, WARN
    if (!ADMIN_MESSAGE_TYPES.has(type) && !BUZZER_MESSAGE_TYPES.has(type)) {
      logWarn("GAME_MESSAGE_IGNORED", { reason: "Unknown type", type, sub });
      return;
    }

    // ── Admin messages ──────────────────────────────────────────────────────

    if (role === "admin") {
      let result;

      if (type === "trigger_title") {
        result = orchestrator.handleTriggerTitle();
        if (result.ok) {
          questionStartedAtMs = null; // reset for next question
        }
      } else if (type === "trigger_choices") {
        result = orchestrator.handleTriggerChoices();
        if (result.ok) {
          questionStartedAtMs = Date.now();
        }
      } else if (type === "trigger_correction") {
        result = await orchestrator.handleTriggerCorrection();
      } else if (type === "trigger_next_question") {
        result = orchestrator.handleTriggerNextQuestion();
      } else if (type === "validate_answer") {
        result = await orchestrator.handleValidateAnswer();
      } else if (type === "invalidate_answer") {
        result = await orchestrator.handleInvalidateAnswer();
      } else if (type === "trigger_intermediate_ranking") {
        result = orchestrator.handleTriggerIntermediateRanking();
      }

      if (result && !result.ok) {
        sendJson(ws, {
          type: "error",
          code: result.error.code,
          message: result.error.message,
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
            reason: result.reason,
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
      // CA-21: participant not in game → orchestrator will reject via UNKNOWN_PARTICIPANT
      const timeMs = questionStartedAtMs ? Date.now() - questionStartedAtMs : 0;

      const result = orchestrator.handleAnswer(
        participantOrder ?? -1,
        msg.value,
        timeMs
      );

      if (!result.accepted) {
        logWarn("GAME_ANSWER_IGNORED", {
          reason: result.reason,
          participant_order: participantOrder,
          sub,
        });
      }
    }
  }

  // ── WebSocket lifecycle ───────────────────────────────────────────────────

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
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

  wss.on("connection", (ws, req) => {
    const ip = req.socket.remoteAddress || "unknown";
    logInfo("WEBSOCKET_CONNECTED", { ip });

    // sub of the authenticated user (null until authenticated)
    let sub = null;

    const authTimer = setTimeout(() => {
      logWarn("WEBSOCKET_AUTH_FAILED", { reason: "Authentication timeout.", ip });
      ws.close(WS_CLOSE_AUTH_TIMEOUT, "Authentication timeout.");
    }, authTimeoutMs);

    ws.on("message", (data) => {
      // Post-auth: route to game message handler (CA-37 to CA-42)
      if (sub !== null) {
        handleGameMessage(data, sub, ws);
        return;
      }

      // Cancel auth timer on first message (CA-9)
      clearTimeout(authTimer);

      // Parse JSON (CA-10)
      let msg;
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
      let decoded;
      try {
        decoded = jwt.verify(msg.token, jwtSecret, { algorithms: ["HS256"] });
      } catch (err) {
        if (err.name === "TokenExpiredError") {
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
      let user;
      try {
        user = findById(db, tokenSub);
      } catch (err) {
        logError("INTERNAL_ERROR", { message: err.message, ip });
        ws.close(1011, "Internal server error.");
        return;
      }

      if (!user) {
        logWarn("WEBSOCKET_AUTH_FAILED", { reason: "Invalid token.", ip });
        ws.close(WS_CLOSE_INVALID_TOKEN, "Invalid token.");
        return;
      }

      // Helper: close and remove an existing session from the registry
      function replaceExistingSession(existingSub) {
        const existing = registry.get(existingSub);
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

      // Only log disconnect if this ws is still the registered connection (CA-21)
      if (sub !== null) {
        const entry = registry.get(sub);
        if (entry && entry.ws === ws) {
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

    ws.on("error", (err) => {
      logError("INTERNAL_ERROR", { message: err.message, ip });
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1011, "Internal server error.");
      }
    });
  });

  function buzzersConnected() {
    return [...registry.values()].filter((c) => c.role === "buzzer").length;
  }

  function adminConnected() {
    return [...registry.values()].filter((c) => c.role === "admin").length;
  }

  function connectedSummary() {
    return {
      buzzers_connected: buzzersConnected(),
      buzzers_max: MAX_BUZZERS,
      admin_connected: adminConnected(),
    };
  }

  return wss;
}
