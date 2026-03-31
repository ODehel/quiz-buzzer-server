import { WebSocket } from "ws";
import Database from "better-sqlite3";
import { WsMessage, GameOrchestrator, ParticipantRow } from "../types/index.ts";
import { WsRegistry } from "./wsRegistry.ts";
import { sendJson } from "./wsGameSender.ts";
import { handlePlaySound, handleTriggerSystemSound } from "./wsSoundHandler.ts";
import { logWarn } from "../utils/logger.ts";
import { findActiveGame } from "../repositories/gameanswerRepository.ts";
import { findParticipantsByGameId } from "../repositories/gameRepository.ts";
import { syncGameStateOnConnect } from "../game/gameSync.ts";

/** Message types reserved for admin (game master). */
const ADMIN_MESSAGE_TYPES = new Set([
  "trigger_title", "trigger_choices", "trigger_correction", "trigger_next_question",
  "validate_answer", "invalidate_answer", "trigger_intermediate_ranking",
  "request_game_state",
]);

/** Message types reserved for buzzers (players). */
const BUZZER_MESSAGE_TYPES = new Set(["answer", "buzz"]);

interface MessageRouterDeps {
  registry: WsRegistry;
  db: Database.Database;
  orchestrator: GameOrchestrator;
  sender: { sendToAdmin(msg: WsMessage): void };
  sendJson: typeof sendJson;
  getConnectedBuzzerUsernames: () => string[];
  serverBaseUrl: string;
}

interface MessageRouter {
  handleGameMessage(data: Buffer | string, sub: string, ws: WebSocket): Promise<void>;
}

/**
 * Creates a message router that dispatches post-auth game messages.
 */
export function createMessageRouter({
  registry,
  db,
  orchestrator,
  sendJson: sendJsonFn,
  getConnectedBuzzerUsernames,
  serverBaseUrl,
}: MessageRouterDeps): MessageRouter {
  // Tracks when the current question's choices were shown (used to compute timeMs for answers)
  let questionStartedAtMs: number | null = null;

  /** OCP: registre des handlers admin — ajouter un type = ajouter une entrée */
  const adminMessageHandlers: Record<string, () => ReturnType<typeof orchestrator.handleTriggerTitle> | ReturnType<typeof orchestrator.handleTriggerCorrection>> = {
    trigger_title: () => {
      const result = orchestrator.handleTriggerTitle();
      if (result.ok) questionStartedAtMs = null;
      return result;
    },
    trigger_choices: () => {
      const result = orchestrator.handleTriggerChoices();
      if (result.ok) questionStartedAtMs = Date.now();
      return result;
    },
    trigger_correction: () => orchestrator.handleTriggerCorrection(),
    trigger_next_question: () => orchestrator.handleTriggerNextQuestion(),
    validate_answer: () => orchestrator.handleValidateAnswer(),
    invalidate_answer: () => orchestrator.handleInvalidateAnswer(),
    trigger_intermediate_ranking: () => orchestrator.handleTriggerIntermediateRanking(),
  };

  /**
   * Resolves the participant order for a buzzer.
   * Primary: buzzer quiz_buzzer_XX maps to participant order XX.
   * Fallback: match username against participant name (case-insensitive).
   */
  function resolveParticipantOrder(username: string): number | null {
    const game = findActiveGame(db);
    if (!game) return null;

    const participants = findParticipantsByGameId(db, game.GAM_ID) as ParticipantRow[];

    // Primary: quiz_buzzer_XX -> participant order XX
    const buzzerOrder = registry.extractBuzzerOrder(username);
    if (buzzerOrder !== null) {
      const match = participants.find((p) => p.GPA_ORDER === buzzerOrder);
      if (match) return match.GPA_ORDER;
    }

    // Fallback: match by participant name
    const matchByName = participants.find(
      (p) => p.GPA_NAME.toLowerCase() === username.toLowerCase()
    );
    return matchByName ? matchByName.GPA_ORDER : null;
  }

  /**
   * Handles a game-related message received from an authenticated client.
   * Enforces CA-37, CA-38, CA-40, CA-41, CA-42.
   */
  async function handleGameMessage(data: Buffer | string, sub: string, ws: WebSocket): Promise<void> {
    const entry = registry.get(sub);
    if (!entry) return;

    const { role, username } = entry;

    // CA-41: silently ignore invalid JSON, log WARN
    let msg: Record<string, unknown>;
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

    // CA-37: buzzer sending admin-only message -> ignore, WARN
    if (role === "buzzer" && ADMIN_MESSAGE_TYPES.has(type as string)) {
      logWarn("GAME_MESSAGE_IGNORED", { reason: "Role not allowed to send this message type", role, type, sub });
      return;
    }

    // CA-38: admin sending buzzer-only message -> ignore, WARN
    if (role === "admin" && BUZZER_MESSAGE_TYPES.has(type as string)) {
      logWarn("GAME_MESSAGE_IGNORED", { reason: "Role not allowed to send this message type", role, type, sub });
      return;
    }

    // Handle request_game_state: admin requests a fresh game_state_sync
    if (type === "request_game_state") {
      if (role === "buzzer") {
        logWarn("GAME_MESSAGE_IGNORED", { reason: "Role not allowed to send this message type", role, type, sub });
        return;
      }
      syncGameStateOnConnect(ws, "admin", null, db, {
        getTimerInfo: () => orchestrator.getTimerInfo(),
        connectedBuzzerUsernames: getConnectedBuzzerUsernames(),
      });
      return;
    }

    // Handle play_sound (US-017 CA-22 to CA-30)
    if (type === "play_sound") {
      // CA-26: buzzer cannot send play_sound
      if (role === "buzzer") {
        logWarn("GAME_MESSAGE_IGNORED", { reason: "Role not allowed to send this message type", role, type, sub });
        return;
      }
      handlePlaySound(msg, ws, { db, registry, serverBaseUrl, sendJson: sendJsonFn });
      return;
    }

    // Handle trigger_system_sound (US-018 CA-10 to CA-16)
    if (type === "trigger_system_sound") {
      // CA-15: buzzer cannot trigger system sounds -> ignore silently
      if (role === "buzzer") {
        logWarn("GAME_MESSAGE_IGNORED", { reason: "Role not allowed to send this message type", role, type, sub });
        return;
      }
      handleTriggerSystemSound(msg, ws, { registry, sendJson: sendJsonFn });
      return;
    }

    // CA-40: fully unknown type (neither admin nor buzzer message) -> ignore, WARN
    if (!ADMIN_MESSAGE_TYPES.has(type as string) && !BUZZER_MESSAGE_TYPES.has(type as string)) {
      logWarn("GAME_MESSAGE_IGNORED", { reason: "Unknown type", type, sub });
      return;
    }

    // ── Admin messages (OCP: handler registry) ────────────────────────────

    if (role === "admin") {
      const handler = adminMessageHandlers[type as string];
      if (!handler) return;

      const result = await handler();

      if (result && !result.ok) {
        sendJsonFn(ws, {
          type: "error",
          code: result.error!.code,
          message: result.error!.message,
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
            reason: result.reason ?? "Unknown",
            participant_order: participantOrder,
            sub,
          });
        }
        return;
      }

      // MCQ: handle answer
      // CA-42: validate required fields for 'answer'
      if (typeof msg.value !== "string") {
        sendJsonFn(ws, {
          type: "error",
          code: "INVALID_MESSAGE",
          message: "Missing or invalid 'value' field.",
        });
        return;
      }

      const participantOrder = resolveParticipantOrder(username);
      // CA-21: participant not in game -> orchestrator will reject via UNKNOWN_PARTICIPANT
      const timeMs = questionStartedAtMs ? Date.now() - questionStartedAtMs : 0;

      const result = orchestrator.handleAnswer(
        participantOrder ?? -1,
        msg.value as string,
        timeMs
      );

      if (!result.accepted) {
        logWarn("GAME_ANSWER_IGNORED", {
          reason: result.reason ?? "Unknown",
          participant_order: participantOrder,
          sub,
        });
      }
    }
  }

  return { handleGameMessage };
}
