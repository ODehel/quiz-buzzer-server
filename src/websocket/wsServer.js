import { WebSocketServer } from "ws";
import jwt from "jsonwebtoken";
import { findById } from "../repositories/userRepository.js";
import { logInfo, logWarn, logError } from "../utils/logger.js";

export const MAX_BUZZERS = 10;
export const AUTH_TIMEOUT_MS = 60_000;

export const WS_CLOSE_INVALID_TOKEN = 4001;
export const WS_CLOSE_TOKEN_EXPIRED = 4002;
export const WS_CLOSE_AUTH_TIMEOUT = 4003;
export const WS_CLOSE_SESSION_REPLACED = 4004;

/**
 * Attaches a WebSocket server to the existing HTTP server on the /ws endpoint.
 *
 * @param {import("node:http").Server} httpServer
 * @param {import("better-sqlite3").Database} db
 * @param {string} jwtSecret
 * @param {Object} [opts]
 * @param {number} [opts.authTimeoutMs] - Auth timeout in ms (injectable for tests)
 * @returns {WebSocketServer}
 */
export function attachWebSocket(httpServer, db, jwtSecret, {
  authTimeoutMs = AUTH_TIMEOUT_MS,
} = {}) {
  const wss = new WebSocketServer({ noServer: true });

  // registry: Map<sub, { ws, role, username, connectedAt }>
  const registry = new Map();

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

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/ws") {
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
      // Ignore messages after authentication (CA-23)
      if (sub !== null) {
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

      // Handle session replacement for same sub (CA-13, CA-17)
      if (registry.has(tokenSub)) {
        const existing = registry.get(tokenSub);
        registry.delete(tokenSub);
        existing.ws.close(WS_CLOSE_SESSION_REPLACED, "Session replaced.");
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
              registry.delete(existingSub);
              entry.ws.close(WS_CLOSE_SESSION_REPLACED, "Session replaced.");
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

      // Send auth_success (CA-6)
      ws.send(JSON.stringify({
        type: "auth_success",
        role: tokenRole,
        username: user.USR_USERNAME,
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
      try {
        ws.close(1011, "Internal server error.");
      } catch {
        // already closed
      }
    });
  });

  return wss;
}
