import { logWarn, logError } from "../utils/logger.js";

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_MAX_MISSED = 3;

/**
 * Stores the heartbeat timer reference for each WebSocket connection.
 * @type {Map<import("ws").WebSocket, NodeJS.Timeout>}
 */
const timers = new Map();

/**
 * Starts the heartbeat cycle for an authenticated WebSocket connection.
 * Sends RFC 6455 Ping frames at a fixed interval and tracks missed Pongs.
 * After `maxMissed` consecutive missed Pongs, closes the connection.
 *
 * @param {import("ws").WebSocket} ws
 * @param {{ username: string, role: string }} connectionEntry
 * @param {Object} [opts]
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.maxMissed]
 * @param {Function} [opts.setIntervalFn]
 * @param {Function} [opts.clearIntervalFn]
 * @param {string} [opts.ip]
 */
export function startHeartbeat(ws, connectionEntry, {
  intervalMs = HEARTBEAT_INTERVAL_MS,
  maxMissed = HEARTBEAT_MAX_MISSED,
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
  ip = "unknown",
} = {}) {
  // Prevent duplicate heartbeat for the same ws
  stopHeartbeat(ws, { clearIntervalFn });

  let missedPings = 0;

  // Reset missed counter on Pong reception (CA-5)
  ws.on("pong", () => {
    missedPings = 0;
  });

  const timer = setIntervalFn(() => {
    try {
      // CA-7: close after maxMissed consecutive missed pongs
      if (missedPings >= maxMissed) {
        // CA-8: log WEBSOCKET_HEARTBEAT_TIMEOUT before closing
        logWarn("WEBSOCKET_HEARTBEAT_TIMEOUT", {
          username: connectionEntry.username,
          role: connectionEntry.role,
          ip,
          missed_pings: missedPings,
        });
        stopHeartbeat(ws, { clearIntervalFn });
        ws.close(1000, "Heartbeat timeout.");
        return;
      }

      // CA-4: send RFC 6455 Ping frame, then increment missed counter (CA-6)
      ws.ping();
      missedPings++;
    } catch (err) {
      // CA-12: unexpected error during heartbeat
      logError("INTERNAL_ERROR", {
        message: err.message,
        username: connectionEntry.username,
        role: connectionEntry.role,
        ip,
      });
      stopHeartbeat(ws, { clearIntervalFn });
      ws.close(1011, "Internal server error.");
    }
  }, intervalMs);

  timers.set(ws, timer);
}

/**
 * Stops the heartbeat for a given WebSocket connection.
 *
 * @param {import("ws").WebSocket} ws
 * @param {Object} [opts]
 * @param {Function} [opts.clearIntervalFn]
 */
export function stopHeartbeat(ws, { clearIntervalFn = globalThis.clearInterval } = {}) {
  const timer = timers.get(ws);
  if (timer !== undefined) {
    clearIntervalFn(timer);
    timers.delete(ws);
  }
}
