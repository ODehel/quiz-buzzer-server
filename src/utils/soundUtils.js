import { WebSocket } from "ws";
import { logInfo, logWarn } from "./logger.js";

/**
 * Sends a play_system_sound message to a single WebSocket connection.
 * Non-blocking: errors are caught and logged as WARN (CA-9, spec: never interrupt workflow).
 *
 * @param {import("ws").WebSocket} ws
 * @param {string} soundId
 */
export function sendSystemSound(ws, soundId) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "play_system_sound", sound_id: soundId }));
    }
  } catch (err) {
    logWarn("SYSTEM_SOUND_SEND_FAILED", { sound_id: soundId, error: err.message });
  }
}

/**
 * Broadcasts a play_system_sound to all connected buzzers from the registry.
 * Used for automatic triggers (timer_end, game_start, game_end) and manual broadcast.
 *
 * @param {Map} registry - WebSocket connection registry
 * @param {string} soundId
 * @param {string} trigger - "auto" or "manual"
 */
export function broadcastSystemSoundToBuzzers(registry, soundId, trigger) {
  let targetsReached = 0;

  for (const entry of registry.values()) {
    if (entry.role === "buzzer") {
      try {
        if (entry.ws.readyState === WebSocket.OPEN) {
          entry.ws.send(JSON.stringify({ type: "play_system_sound", sound_id: soundId }));
          targetsReached++;
        }
      } catch (err) {
        logWarn("SYSTEM_SOUND_SEND_FAILED", {
          sound_id: soundId,
          username: entry.username,
          error: err.message,
        });
      }
    }
  }

  if (targetsReached === 0) {
    logInfo("SYSTEM_SOUND_NO_TARGETS", { sound_id: soundId, trigger });
  } else {
    logInfo("SYSTEM_SOUND_SENT", { sound_id: soundId, trigger, targets_reached: targetsReached });
  }
}
