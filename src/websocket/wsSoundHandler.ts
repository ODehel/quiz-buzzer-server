import { WebSocket } from "ws";
import Database from "better-sqlite3";
import type { WsMessage, WsRegistryEntry } from "../types/index.ts";
import { WsRegistry } from "./wsRegistry.ts";
import { sendJson } from "./wsGameSender.ts";
import { logInfo, logWarn } from "../utils/logger.ts";
import { findSoundById } from "../repositories/soundRepository.ts";
import { SYSTEM_SOUNDS } from "../constants/systemSounds.ts";
import { broadcastSystemSoundToBuzzers, sendSystemSound } from "../utils/soundUtils.ts";

interface PlaySoundDeps {
  db: Database.Database;
  registry: WsRegistry;
  serverBaseUrl: string;
  sendJson: typeof sendJson;
}

interface TriggerSystemSoundDeps {
  registry: WsRegistry;
  sendJson: typeof sendJson;
}

/**
 * Handles the play_sound message from admin (CA-22 to CA-30).
 */
export function handlePlaySound(
  msg: Record<string, unknown>,
  ws: WebSocket,
  { db, registry, serverBaseUrl, sendJson: sendJsonFn }: PlaySoundDeps,
): void {
  // CA-28: Validate sound_id
  if (!msg.sound_id || typeof msg.sound_id !== "string") {
    sendJsonFn(ws, {
      type: "error",
      code: "INVALID_MESSAGE",
      message: "Missing or invalid field: sound_id.",
    });
    return;
  }

  // CA-25: Check sound exists in DB
  const sound = findSoundById(db, msg.sound_id as string);
  if (!sound) {
    sendJsonFn(ws, {
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
      sendJsonFn(entry.ws, playSoundMsg);
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
      sendJsonFn(targetEntry.ws, playSoundMsg);
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

/**
 * Handles the trigger_system_sound message from admin (US-018 CA-10 to CA-14).
 */
export function handleTriggerSystemSound(
  msg: Record<string, unknown>,
  ws: WebSocket,
  { registry, sendJson: sendJsonFn }: TriggerSystemSoundDeps,
): void {
  // CA-12: sound_id absent or empty
  if (!msg.sound_id || typeof msg.sound_id !== "string") {
    sendJsonFn(ws, {
      type: "error",
      code: "INVALID_MESSAGE",
      message: "Missing or invalid field: sound_id.",
    });
    return;
  }

  // CA-13: sound_id not in catalogue
  if (!SYSTEM_SOUNDS.has(msg.sound_id as string)) {
    sendJsonFn(ws, {
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
    broadcastSystemSoundToBuzzers(registry.getMap(), msg.sound_id as string, "manual");
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
