import { WebSocketServer, WebSocket } from "ws";
import { Server, IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { HeartbeatOptions } from "../types/index.ts";
import { logInfo, logWarn, logError } from "../utils/logger.ts";
import logger from "../config/logger.ts";
import { createGameOrchestrator } from "../game/gameOrchestrator.ts";
import { RateLimiter } from "../middlewares/rateLimiter.ts";
import { stopHeartbeat } from "./ws-heartbeat.ts";
import { clearTokenTimers, handleAuthRefresh } from "./tokenRefreshHandler.ts";
import { runWithCorrelationId } from "../utils/correlationStore.ts";
import { broadcastSystemSoundToBuzzers } from "../utils/soundUtils.ts";

import { WsRegistry } from "./wsRegistry.ts";
import { createGameSender, sendJson } from "./wsGameSender.ts";
import {
  authenticateConnection,
  WS_CLOSE_AUTH_TIMEOUT,
  AUTH_TIMEOUT_MS,
} from "./wsAuth.ts";
import { createMessageRouter } from "./wsMessageRouter.ts";

// Re-export constants so existing consumers continue to work
export { MAX_BUZZERS } from "./wsRegistry.ts";
export {
  WS_CLOSE_INVALID_TOKEN,
  WS_CLOSE_TOKEN_EXPIRED,
  WS_CLOSE_AUTH_TIMEOUT,
  WS_CLOSE_SESSION_REPLACED,
  AUTH_TIMEOUT_MS,
} from "./wsAuth.ts";

export const WS_RATE_LIMIT_CONNECTIONS = 15;
export const WS_RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute

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

  // ── Module instantiation ──────────────────────────────────────────────────

  const registry = new WsRegistry(db);
  const sender = createGameSender(registry);
  const orchestrator = createGameOrchestrator(db, sender, orchestratorOptions as { persistFn?: undefined; retryOptions?: undefined });

  const messageRouter = createMessageRouter({
    registry,
    db,
    orchestrator,
    sender,
    sendJson,
    getConnectedBuzzerUsernames: () => registry.getConnectedBuzzerUsernames(),
    serverBaseUrl,
  });

  // Rate limiter for WebSocket connection attempts (per IP)
  const wsRateLimiter = new RateLimiter(wsRateLimitConnections, wsRateLimitWindowMs);

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
              handleAuthRefresh(msg as { type: string; token?: string }, ws, sub!, registry.getMap(), jwtSecret, tokenTimerOptions);
            } catch (err: unknown) {
              logError("INTERNAL_ERROR", { message: (err as Error).message });
              ws.close(1011, "Internal server error.");
            }
            return;
          }

          messageRouter.handleGameMessage(data, sub!, ws);
        });
        return;
      }

      // Cancel auth timer on first message (CA-9)
      clearTimeout(authTimer);

      // Delegate to auth module
      sub = authenticateConnection(data, ws, {
        registry,
        db,
        jwtSecret,
        sender,
        orchestrator,
        heartbeatOptions,
        tokenTimerOptions,
        ip,
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
            ...registry.connectedSummary(),
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

  // Expose notification function for game state changes (CA-7, CA-8)
  wss._notifyGameStateChange = (newStatus: string) => {
    if (newStatus === "OPEN") {
      broadcastSystemSoundToBuzzers(registry.getMap(), "GAME_START", "auto");
    } else if (newStatus === "COMPLETED") {
      broadcastSystemSoundToBuzzers(registry.getMap(), "GAME_END", "auto");
    }
  };

  // Point de vigilance US-010: nettoyage des ressources en mémoire avant suppression SQL
  wss._notifyGameDeleted = (_gameId: string) => {
    orchestrator.cleanupGameState();
  };

  return wss;
}
