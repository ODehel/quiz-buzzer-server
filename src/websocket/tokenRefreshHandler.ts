import { WebSocket } from "ws";
import jwt from "jsonwebtoken";
import type { WsRegistryEntry, JwtPayload } from "../types/index.ts";
import { logInfo, logWarn } from "../utils/logger.ts";

export const TOKEN_EXPIRING_SOON_SECONDS = 300;

interface TokenTimerOptions {
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/**
 * Schedules token expiration timers after a successful authentication.
 * - Timer 1: sends `token_expiring_soon` at `exp - now - 300s`
 * - Timer 2: sends `token_expired` at `exp - now`, then closes the connection
 */
export function scheduleTokenTimers(
  ws: WebSocket,
  entry: WsRegistryEntry,
  exp: number,
  _registry: Map<string, WsRegistryEntry>,
  _sub: string,
  {
    setTimeoutFn = globalThis.setTimeout,
    clearTimeoutFn = globalThis.clearTimeout,
  }: TokenTimerOptions = {},
): void {
  // Clear any existing timers (CA-11: reprogram after refresh)
  clearTokenTimers(entry, { clearTimeoutFn });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiringSoonDelay = Math.max(0, (exp - nowSeconds - TOKEN_EXPIRING_SOON_SECONDS) * 1000);
  const expiredDelay = Math.max(0, (exp - nowSeconds) * 1000);

  // CA-1, CA-2: token_expiring_soon timer
  entry.tokenExpiringSoonTimer = setTimeoutFn(() => {
    // CA-3: only send to the specific client
    if (ws.readyState === 1 /* WebSocket.OPEN */) {
      ws.send(JSON.stringify({
        type: "token_expiring_soon",
        expires_in: TOKEN_EXPIRING_SOON_SECONDS,
      }));
      logInfo("WEBSOCKET_TOKEN_EXPIRING_SOON", {
        username: entry.username,
        role: entry.role,
        expires_in: TOKEN_EXPIRING_SOON_SECONDS,
      });
    }
  }, expiringSoonDelay);

  // CA-5, CA-6, CA-7: token_expired timer
  entry.tokenExpiredTimer = setTimeoutFn(() => {
    if (ws.readyState === 1 /* WebSocket.OPEN */) {
      ws.send(JSON.stringify({ type: "token_expired" }));
      logWarn("WEBSOCKET_TOKEN_EXPIRED", {
        username: entry.username,
        role: entry.role,
      });
      // CA-7: close with 4002
      ws.close(4002, "Token expired.");
    }
  }, expiredDelay);
}

/**
 * Clears both token expiration timers for a registry entry.
 * Safe to call even if timers are undefined.
 */
export function clearTokenTimers(entry: WsRegistryEntry | undefined, {
  clearTimeoutFn = globalThis.clearTimeout,
}: { clearTimeoutFn?: typeof clearTimeout } = {}): void {
  if (entry) {
    clearTimeoutFn(entry.tokenExpiringSoonTimer);
    clearTimeoutFn(entry.tokenExpiredTimer);
    entry.tokenExpiringSoonTimer = undefined;
    entry.tokenExpiredTimer = undefined;
  }
}

interface AuthRefreshMessage {
  type: string;
  token?: string;
}

/**
 * Handles an `auth_refresh` message on an existing WebSocket connection.
 */
export function handleAuthRefresh(
  msg: AuthRefreshMessage,
  ws: WebSocket,
  sub: string,
  registry: Map<string, WsRegistryEntry>,
  jwtSecret: string,
  {
    setTimeoutFn = globalThis.setTimeout,
    clearTimeoutFn = globalThis.clearTimeout,
  }: TokenTimerOptions = {},
): void {
  const entry = registry.get(sub);

  // CA-18: auth_refresh from unauthenticated client
  if (!entry) {
    logWarn("WEBSOCKET_TOKEN_REFRESH_IGNORED", { reason: "Client not authenticated" });
    return;
  }

  // CA-16, CA-17: token field missing or not a string
  if (!msg.token || typeof msg.token !== "string") {
    ws.send(JSON.stringify({
      type: "error",
      code: "INVALID_MESSAGE",
      message: "Missing or invalid 'token' field.",
    }));
    return;
  }

  // Verify the new JWT
  let decoded: JwtPayload;
  try {
    decoded = jwt.verify(msg.token, jwtSecret, { algorithms: ["HS256"] }) as JwtPayload;
  } catch (err: unknown) {
    if ((err as Error).name === "TokenExpiredError") {
      // CA-14: token already expired
      logWarn("WEBSOCKET_TOKEN_REFRESH_FAILED", {
        username: entry.username,
        role: entry.role,
        reason: "TOKEN_EXPIRED",
      });
      ws.send(JSON.stringify({
        type: "error",
        code: "TOKEN_EXPIRED",
        message: "The provided token has already expired.",
      }));
      ws.close(4002, "Token expired.");
    } else {
      // CA-15: invalid signature or format
      logWarn("WEBSOCKET_TOKEN_REFRESH_FAILED", {
        username: entry.username,
        role: entry.role,
        reason: "TOKEN_INVALID",
      });
      ws.send(JSON.stringify({
        type: "error",
        code: "TOKEN_INVALID",
        message: "The provided token is invalid.",
      }));
      ws.close(4001, "Invalid token.");
    }
    return;
  }

  // CA-12, CA-13: sub and role must match current session
  if (decoded.sub !== sub || decoded.role !== entry.role) {
    logWarn("WEBSOCKET_TOKEN_REFRESH_FAILED", {
      username: entry.username,
      role: entry.role,
      reason: "TOKEN_MISMATCH",
    });
    ws.send(JSON.stringify({
      type: "error",
      code: "TOKEN_MISMATCH",
      message: "Token identity does not match the current session.",
    }));
    ws.close(4001, "Invalid token.");
    return;
  }

  // CA-11: Success - reprogram timers
  const expiresIn = decoded.exp - Math.floor(Date.now() / 1000);

  scheduleTokenTimers(ws, entry, decoded.exp, registry, sub, {
    setTimeoutFn,
    clearTimeoutFn,
  });

  // Send auth_success (same format as US-009)
  ws.send(JSON.stringify({
    type: "auth_success",
    role: entry.role,
    username: entry.username,
    expires_in: expiresIn,
  }));

  logInfo("WEBSOCKET_TOKEN_REFRESHED", {
    username: entry.username,
    role: entry.role,
  });
}
