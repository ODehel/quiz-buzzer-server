import { WebSocket } from "ws";
import { logInfo, logWarn } from "./logger.ts";

import { WsRegistryEntry } from "../types/index.ts";

/**
 * Sends a play_system_sound message to a single WebSocket connection.
 * Non-blocking: errors are caught and logged as WARN (CA-9, spec: never interrupt workflow).
 */
export function sendSystemSound(ws: WebSocket, soundId: string): void {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "play_system_sound", sound_id: soundId }));
    }
  } catch (err: unknown) {
    logWarn("SYSTEM_SOUND_SEND_FAILED", { sound_id: soundId, error: (err as Error).message });
  }
}

/**
 * Broadcasts a play_system_sound to all connected buzzers from the registry.
 * Used for automatic triggers (timer_end, game_start, game_end) and manual broadcast.
 */
export function broadcastSystemSoundToBuzzers(registry: Map<string, WsRegistryEntry>, soundId: string, trigger: string): void {
  let targetsReached = 0;

  for (const entry of registry.values()) {
    if (entry.role === "buzzer") {
      try {
        if (entry.ws.readyState === WebSocket.OPEN) {
          entry.ws.send(JSON.stringify({ type: "play_system_sound", sound_id: soundId }));
          targetsReached++;
        }
      } catch (err: unknown) {
        logWarn("SYSTEM_SOUND_SEND_FAILED", {
          sound_id: soundId,
          username: entry.username,
          error: (err as Error).message,
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
