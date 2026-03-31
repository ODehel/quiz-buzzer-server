import { WebSocket } from "ws";
import { WsMessage, GameSender } from "../types/index.ts";
import { WsRegistry } from "./wsRegistry.ts";
import { broadcastSystemSoundToBuzzers, sendSystemSound } from "../utils/soundUtils.ts";
import logger from "../config/logger.ts";

/**
 * Sends a JSON message to a WebSocket connection if it is open.
 */
export function sendJson(ws: WebSocket, msg: WsMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    const payload = JSON.stringify(msg);
    // CA-26: log messages WebSocket sortants en DEBUG
    logger.debug({ event: "WEBSOCKET_MESSAGE_SENT", type: msg.type, raw: payload });
    ws.send(payload);
  }
}

/**
 * Creates a GameSender implementation backed by the given registry.
 */
export function createGameSender(registry: WsRegistry): GameSender {
  return {
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
      const entry = registry.findBuzzerEntryByOrder(participantOrder);
      if (entry) {
        sendJson(entry.ws, msg);
      }
    },

    /**
     * Send a system sound to a specific buzzer (US-018 auto-triggers).
     * Non-blocking: errors are caught and logged.
     */
    sendSystemSoundToBuzzer(participantOrder: number, soundId: string): void {
      const entry = registry.findBuzzerEntryByOrder(participantOrder);
      if (entry) {
        sendSystemSound(entry.ws, soundId);
      }
    },

    /**
     * Broadcast a system sound to all connected buzzers (US-018 auto-triggers).
     */
    broadcastSystemSound(soundId: string): void {
      broadcastSystemSoundToBuzzers(registry.getMap(), soundId, "auto");
    },
  };
}
