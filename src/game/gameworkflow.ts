/**
 * Machine à états et orchestration du workflow MCQ.
 *
 * Responsabilités :
 * - Définition des transitions autorisées (CA-1)
 * - Validation et exécution des transitions (CA-2, CA-3)
 * - Résolution de la question courante (CA-5, CA-7)
 * - Détection de fin de quiz (CA-29, CA-30)
 */

import Database from "better-sqlite3";
import { GameStatus, QuestionRow } from "../types/index.ts";
import { findGameById, updateGameStatus } from "../repositories/gameRepository.ts";

/**
 * Transitions autorisées depuis chaque état (CA-1, CA-3).
 * La progression est strictement linéaire et irréversible.
 * IN_ERROR est accessible depuis tout état non-terminal.
 */
export const ALLOWED_TRANSITIONS: Record<GameStatus, GameStatus[]> = {
  PENDING:          ["OPEN", "IN_ERROR"],
  OPEN:             ["QUESTION_TITLE", "QUESTION_OPEN", "IN_ERROR"],
  QUESTION_TITLE:   ["QUESTION_OPEN", "IN_ERROR"],
  QUESTION_OPEN:    ["QUESTION_BUZZED", "QUESTION_CLOSED", "IN_ERROR"],
  QUESTION_BUZZED:  ["QUESTION_OPEN", "QUESTION_CLOSED", "IN_ERROR"],
  QUESTION_CLOSED:  ["OPEN", "COMPLETED", "IN_ERROR"],
  COMPLETED:        [],
  IN_ERROR:         [],
};

/**
 * Valide et exécute une transition d'état (CA-1, CA-2, CA-3).
 *
 * Vérifie que :
 * 1. La partie existe
 * 2. L'état actuel en base correspond à `currentStatus` (protection contre les race conditions)
 * 3. La transition vers `newStatus` est autorisée
 *
 * @throws {Error} GAME_NOT_FOUND | STATE_MISMATCH | INVALID_TRANSITION
 */
export function transitionState(db: Database.Database, gameId: string, currentStatus: GameStatus, newStatus: GameStatus): void {
  const game = findGameById(db, gameId);
  if (!game) {
    throw new Error("GAME_NOT_FOUND");
  }

  if (game.GAM_STATUS !== currentStatus) {
    throw new Error("STATE_MISMATCH");
  }

  const allowed = ALLOWED_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(newStatus)) {
    throw new Error("INVALID_TRANSITION");
  }

  updateGameStatus(db, gameId, newStatus);
}

/**
 * Résout la question à l'index donné dans un quiz (CA-5, CA-7).
 *
 * Utilise la table de liaison T_QUIZ_QUESTION_QQN pour retrouver
 * la question à l'ordre (index + 1), puis charge ses détails complets.
 */
export function resolveCurrentQuestion(db: Database.Database, quizId: string, questionIndex: number): QuestionRow | undefined {
  if (questionIndex < 0) return undefined;

  const order = questionIndex + 1; // QQN_ORDER is 1-based

  const link = db
    .prepare(
      `SELECT QQN_QUESTION_ID FROM T_QUIZ_QUESTION_QQN
       WHERE QQN_QUIZ_ID = ? AND QQN_ORDER = ?`
    )
    .get(quizId, order) as { QQN_QUESTION_ID: string } | undefined;

  if (!link) return undefined;

  return db
    .prepare(`SELECT * FROM T_QUESTION_QST WHERE QST_ID = ?`)
    .get(link.QQN_QUESTION_ID) as QuestionRow | undefined;
}

/**
 * Vérifie s'il reste des questions après l'index donné (CA-29, CA-30).
 */
export function hasMoreQuestions(db: Database.Database, quizId: string, currentIndex: number): boolean {
  const nextOrder = currentIndex + 2; // next index (0-based + 1) converted to 1-based order

  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM T_QUIZ_QUESTION_QQN
       WHERE QQN_QUIZ_ID = ? AND QQN_ORDER = ?`
    )
    .get(quizId, nextOrder) as { c: number };

  return row.c > 0;
}
