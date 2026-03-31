/**
 * Synchronisation de l'état de jeu à la reconnexion d'un client (US-019).
 *
 * Ce module s'exécute à chaque reconnexion d'un client authentifié,
 * immédiatement après l'envoi de auth_success.
 *
 * Responsabilité unique (SRP) : envoyer l'état courant de la partie
 * aux clients reconnectés (admin -> game_state_sync, buzzer -> game_resumed).
 */

import Database from "better-sqlite3";
import { WebSocket } from "ws";
import type { WsMessage, TimerInfo, GameStatus, GameSyncOptions } from "../types/index.ts";
import { resolveCurrentQuestion } from "./gameworkflow.ts";
import { logInfo } from "../utils/logger.ts";

/** Statuts nécessitant les données du chronomètre (CA-13). */
const TIMER_STATUSES = new Set<GameStatus>(["QUESTION_OPEN", "QUESTION_BUZZED"]);

/** Statuts nécessitant la réponse attendue pour l'admin. */
const ANSWER_STATUSES = new Set<GameStatus>(["QUESTION_TITLE", "QUESTION_OPEN", "QUESTION_BUZZED"]);

interface GameSyncRow {
  GAM_ID: string;
  GAM_STATUS: GameStatus;
  GAM_CURRENT_QUESTION_INDEX: number;
  GAM_QUIZ_ID: string;
}

interface ParticipantScoreRow {
  participant_order: number;
  name: string;
  cumulative_score: number;
}

/**
 * Envoie l'état courant de la partie à un client reconnecté.
 *
 * - Rôle admin -> game_state_sync (CA-10 à CA-15)
 * - Rôle buzzer -> game_resumed (CA-16 à CA-20)
 */
export function syncGameStateOnConnect(
  ws: WebSocket,
  role: string,
  username: string | null,
  db: Database.Database,
  { getTimerInfo, connectedBuzzerUsernames, sendFn }: GameSyncOptions = {},
): void {
  const send = sendFn || ((msg: WsMessage) => ws.send(JSON.stringify(msg)));

  // Chercher une partie active
  const game = db.prepare(
    `SELECT GAM_ID, GAM_STATUS, GAM_CURRENT_QUESTION_INDEX, GAM_QUIZ_ID
     FROM T_GAME_GAM
     WHERE GAM_STATUS IN ('OPEN', 'QUESTION_TITLE', 'QUESTION_OPEN', 'QUESTION_BUZZED', 'QUESTION_CLOSED')
     LIMIT 1`
  ).get() as GameSyncRow | undefined;

  // CA-10, CA-15, CA-16, CA-20: pas de partie active
  if (!game) {
    // Envoyer quand même la liste des buzzers connectés à l'admin
    if (role === "admin") {
      send({
        type: "connected_buzzers_sync",
        connected_buzzers: connectedBuzzerUsernames || [],
      });
    }
    return;
  }

  if (role === "admin") {
    syncAdmin(send, game, db, getTimerInfo, connectedBuzzerUsernames);
  } else if (role === "buzzer") {
    syncBuzzer(send, game, username, db);
  }
}

/**
 * Envoie game_state_sync à Angular (CA-11 à CA-14).
 */
function syncAdmin(
  send: (msg: WsMessage) => void,
  game: GameSyncRow,
  db: Database.Database,
  getTimerInfo?: () => TimerInfo | null,
  connectedBuzzerUsernames?: string[],
): void {
  // CA-14: Participants avec score cumulé
  const participants = db.prepare(
    `SELECT
       p.GPA_ORDER AS participant_order,
       p.GPA_NAME  AS name,
       COALESCE(
         (SELECT MAX(a.GAA_CUMULATIVE_SCORE)
          FROM T_GAME_ANSWER_GAA a
          WHERE a.GAA_GAME_ID = p.GPA_GAME_ID
            AND a.GAA_PARTICIPANT_ORDER = p.GPA_ORDER),
         0
       ) AS cumulative_score
     FROM T_GAME_PARTICIPANT_GPA p
     WHERE p.GPA_GAME_ID = ?
     ORDER BY p.GPA_ORDER`
  ).all(game.GAM_ID) as ParticipantScoreRow[];

  const msg: Record<string, unknown> = {
    type: "game_state_sync",
    game_id: game.GAM_ID,
    status: game.GAM_STATUS,
    question_index: game.GAM_CURRENT_QUESTION_INDEX,
    quiz_id: game.GAM_QUIZ_ID,
    participants: participants.map((p) => ({
      order: p.participant_order,
      name: p.name,
      cumulative_score: p.cumulative_score,
    })),
    connected_buzzers: connectedBuzzerUsernames || [],
  };

  // CA-13: QUESTION_OPEN ou QUESTION_BUZZED -> inclure started_at et time_limit
  if (TIMER_STATUSES.has(game.GAM_STATUS) && getTimerInfo) {
    const timerInfo = getTimerInfo();
    if (timerInfo) {
      msg.started_at = timerInfo.startedAt;
      msg.time_limit = timerInfo.timeLimit;
    }
  }

  // Include expected answer for admin during question phases
  if (ANSWER_STATUSES.has(game.GAM_STATUS)) {
    const question = resolveCurrentQuestion(db, game.GAM_QUIZ_ID, game.GAM_CURRENT_QUESTION_INDEX);
    if (question) {
      msg.expected_answer = question.QST_CORRECT_ANSWER;
    }
  }

  send(msg as WsMessage);

  // CA-24: Log envoi
  logInfo("GAME_STATE_SYNC_SENT", {
    game_id: game.GAM_ID,
    status: game.GAM_STATUS,
  });
}

/**
 * Envoie game_resumed à un buzzer (CA-17 à CA-19).
 */
function syncBuzzer(
  send: (msg: WsMessage) => void,
  game: GameSyncRow,
  username: string | null,
  db: Database.Database,
): void {
  // Trouver le participant correspondant au buzzer
  const participant = db.prepare(
    `SELECT GPA_ORDER FROM T_GAME_PARTICIPANT_GPA
     WHERE GPA_GAME_ID = ? AND LOWER(GPA_NAME) = LOWER(?)`
  ).get(game.GAM_ID, username) as { GPA_ORDER: number } | undefined;

  // CA-18: Score cumulé du buzzer (0 si aucune réponse — CA-19)
  const cumulativeScore = participant
    ? ((db.prepare(
        `SELECT MAX(GAA_CUMULATIVE_SCORE) AS score
         FROM T_GAME_ANSWER_GAA
         WHERE GAA_GAME_ID = ? AND GAA_PARTICIPANT_ORDER = ?`
      ).get(game.GAM_ID, participant.GPA_ORDER) as { score: number | null } | undefined)?.score ?? 0)
    : 0;

  send({
    type: "game_resumed",
    question_index: game.GAM_CURRENT_QUESTION_INDEX,
    cumulative_score: cumulativeScore,
    status: game.GAM_STATUS,
  });

  // CA-25: Log envoi
  logInfo("GAME_RESUMED_SENT", {
    game_id: game.GAM_ID,
    username: username ?? "",
  });
}
