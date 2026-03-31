import { WebSocket } from "ws";
import Database from "better-sqlite3";
import jwt from "jsonwebtoken";
import {
  JwtPayload,
  UserRow,
  GameSender,
  GameOrchestrator,
  HeartbeatOptions,
} from "../types/index.ts";
import { WsRegistry, MAX_BUZZERS } from "./wsRegistry.ts";
import { findById } from "../repositories/userRepository.ts";
import { logInfo, logWarn, logError } from "../utils/logger.ts";
import { startHeartbeat } from "./ws-heartbeat.ts";
import { syncGameStateOnConnect } from "../game/gameSync.ts";
import { scheduleTokenTimers, clearTokenTimers } from "./tokenRefreshHandler.ts";
import { stopHeartbeat } from "./ws-heartbeat.ts";

export const WS_CLOSE_INVALID_TOKEN = 4001;
export const WS_CLOSE_TOKEN_EXPIRED = 4002;
export const WS_CLOSE_AUTH_TIMEOUT = 4003;
export const WS_CLOSE_SESSION_REPLACED = 4004;
export const AUTH_TIMEOUT_MS = 60_000;

interface AuthenticateConnectionDeps {
  registry: WsRegistry;
  db: Database.Database;
  jwtSecret: string;
  sender: GameSender;
  orchestrator: GameOrchestrator;
  heartbeatOptions: HeartbeatOptions;
  tokenTimerOptions: { setTimeoutFn?: typeof setTimeout; clearTimeoutFn?: typeof clearTimeout };
  ip: string;
}

/**
 * Handles the first-message JWT authentication flow for a WebSocket connection.
 * Returns the authenticated `sub` or `null` if auth failed and connection was closed.
 */
export function authenticateConnection(
  data: Buffer | string,
  ws: WebSocket,
  {
    registry,
    db,
    jwtSecret,
    sender,
    orchestrator,
    heartbeatOptions,
    tokenTimerOptions,
    ip,
  }: AuthenticateConnectionDeps,
): string | null {
  // Parse JSON (CA-10)
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    logWarn("WEBSOCKET_AUTH_FAILED", { reason: "Invalid token.", ip });
    ws.close(WS_CLOSE_INVALID_TOKEN, "Invalid token.");
    return null;
  }

  // Validate message format (CA-11)
  if (!msg || msg.type !== "auth" || typeof msg.token !== "string") {
    logWarn("WEBSOCKET_AUTH_FAILED", { reason: "Invalid token.", ip });
    ws.close(WS_CLOSE_INVALID_TOKEN, "Invalid token.");
    return null;
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
    return null;
  }

  // Validate required claims (CA-5)
  const tokenSub = decoded.sub;
  const tokenRole = decoded.role;
  if (!tokenSub || !tokenRole) {
    logWarn("WEBSOCKET_AUTH_FAILED", { reason: "Invalid token.", ip });
    ws.close(WS_CLOSE_INVALID_TOKEN, "Invalid token.");
    return null;
  }

  // Resolve username from DB (CA-7 — user might have been deleted)
  let user: Pick<UserRow, "USR_ID" | "USR_USERNAME" | "USR_ROLE"> | undefined;
  try {
    user = findById(db, tokenSub);
  } catch (err: unknown) {
    logError("INTERNAL_ERROR", { message: (err as Error).message, ip });
    ws.close(1011, "Internal server error.");
    return null;
  }

  if (!user) {
    logWarn("WEBSOCKET_AUTH_FAILED", { reason: "Invalid token.", ip });
    ws.close(WS_CLOSE_INVALID_TOKEN, "Invalid token.");
    return null;
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
    if (tokenRole === "buzzer" && registry.buzzersConnected() >= MAX_BUZZERS) {
      logWarn("WEBSOCKET_AUTH_FAILED", { reason: "Invalid token.", ip });
      ws.close(WS_CLOSE_INVALID_TOKEN, "Invalid token.");
      return null;
    }

    // CA-17: replace existing admin with different sub
    if (tokenRole === "admin" && registry.adminConnected() >= 1) {
      for (const [existingSub, entry] of registry.entries()) {
        if (entry.role === "admin") {
          replaceExistingSession(existingSub);
          break;
        }
      }
    }
  }

  // Register new connection
  const sub = tokenSub;
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
  scheduleTokenTimers(ws, registry.get(sub)!, decoded.exp, registry.getMap(), sub, tokenTimerOptions);

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
    connectedBuzzerUsernames: registry.getConnectedBuzzerUsernames(),
  });

  // Start heartbeat after successful authentication (US-015 CA-1)
  startHeartbeat(ws, { username: user.USR_USERNAME, role: tokenRole }, { ...heartbeatOptions, ip });

  // Log successful authentication (CA-19)
  logInfo("WEBSOCKET_AUTHENTICATED", {
    username: user.USR_USERNAME,
    role: tokenRole,
    ip,
    ...registry.connectedSummary(),
  });

  return sub;
}
