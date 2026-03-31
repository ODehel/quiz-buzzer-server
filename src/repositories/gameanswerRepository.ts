/**
 * Repository d'accès aux tables T_GAME_ANSWER_GAA et aux champs
 * liés au workflow de la partie dans T_GAME_GAM.
 * Reçoit l'instance DB par injection (DIP — pas d'import global).
 */

import Database from "better-sqlite3";
import { GameAnswerRow, GameAnswerData, GameRow } from "../types/index.ts";

/**
 * Insère une réponse individuelle.
 */
export function insertGameAnswer(db: Database.Database, answer: GameAnswerData): void {
  db.prepare(
    `INSERT INTO T_GAME_ANSWER_GAA
       (GAA_ID, GAA_GAME_ID, GAA_QUESTION_ID, GAA_PARTICIPANT_ORDER,
        GAA_ANSWER, GAA_TIME_MS, GAA_POINTS_EARNED, GAA_CUMULATIVE_SCORE, GAA_CREATED_AT)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    answer.id, answer.gameId, answer.questionId, answer.participantOrder,
    answer.answer ?? null, answer.timeMs, answer.pointsEarned,
    answer.cumulativeScore, answer.createdAt
  );
}

/**
 * Insère plusieurs réponses dans une transaction atomique (CA-32).
 */
export function insertGameAnswers(db: Database.Database, answers: GameAnswerData[]): void {
  const stmt = db.prepare(
    `INSERT INTO T_GAME_ANSWER_GAA
       (GAA_ID, GAA_GAME_ID, GAA_QUESTION_ID, GAA_PARTICIPANT_ORDER,
        GAA_ANSWER, GAA_TIME_MS, GAA_POINTS_EARNED, GAA_CUMULATIVE_SCORE, GAA_CREATED_AT)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertAll = db.transaction((items: GameAnswerData[]) => {
    for (const a of items) {
      stmt.run(
        a.id, a.gameId, a.questionId, a.participantOrder,
        a.answer ?? null, a.timeMs, a.pointsEarned,
        a.cumulativeScore, a.createdAt
      );
    }
  });

  insertAll(answers);
}

/**
 * Retourne les réponses pour une partie et une question données,
 * triées par ordre de participant.
 */
export function findAnswersByGameAndQuestion(db: Database.Database, gameId: string, questionId: string): GameAnswerRow[] {
  return db
    .prepare(
      `SELECT * FROM T_GAME_ANSWER_GAA
       WHERE GAA_GAME_ID = ? AND GAA_QUESTION_ID = ?
       ORDER BY GAA_PARTICIPANT_ORDER`
    )
    .all(gameId, questionId) as GameAnswerRow[];
}

/**
 * Retourne toutes les réponses d'une partie, avec asymétrie SPEED/MCQ.
 *
 * IMPORTANT: Due to SPEED vs MCQ design (US-012 CA-26/CA-27):
 * - MCQ questions: Returns one row per participant (complete for all players)
 * - SPEED questions: Returns 0-1 rows (winner only with GAA_ANSWER="SPEED_WIN", or empty if timeout/all invalid)
 *
 * This is not an SQL bug but intentional — SPEED records only the winner.
 * Ranking queries must account for missing rows in SPEED questions.
 */
export function findAnswersByGame(db: Database.Database, gameId: string): GameAnswerRow[] {
  return db
    .prepare(
      `SELECT * FROM T_GAME_ANSWER_GAA
       WHERE GAA_GAME_ID = ?
       ORDER BY GAA_QUESTION_ID, GAA_PARTICIPANT_ORDER`
    )
    .all(gameId) as GameAnswerRow[];
}

/**
 * Retourne le score cumulé le plus récent d'un participant dans une partie.
 * Retourne 0 si aucune réponse n'existe encore.
 */
export function getCumulativeScore(db: Database.Database, gameId: string, participantOrder: number): number {
  const row = db
    .prepare(
      `SELECT GAA_CUMULATIVE_SCORE FROM T_GAME_ANSWER_GAA
       WHERE GAA_GAME_ID = ? AND GAA_PARTICIPANT_ORDER = ?
       ORDER BY GAA_CREATED_AT DESC
       LIMIT 1`
    )
    .get(gameId, participantOrder) as Pick<GameAnswerRow, "GAA_CUMULATIVE_SCORE"> | undefined;

  return row ? row.GAA_CUMULATIVE_SCORE : 0;
}

/**
 * Met à jour l'index de la question courante d'une partie (CA-2).
 */
export function updateGameQuestionIndex(db: Database.Database, gameId: string, questionIndex: number): void {
  db.prepare(
    `UPDATE T_GAME_GAM SET GAM_CURRENT_QUESTION_INDEX = ? WHERE GAM_ID = ?`
  ).run(questionIndex, gameId);
}

/**
 * Retourne la partie active (tout état sauf COMPLETED et IN_ERROR).
 * Il ne peut y avoir qu'une seule partie active à la fois (contrainte US-010).
 */
export function findActiveGame(db: Database.Database): GameRow | undefined {
  return db
    .prepare(
      `SELECT GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CURRENT_QUESTION_INDEX, GAM_CREATED_AT
       FROM T_GAME_GAM
       WHERE GAM_STATUS NOT IN ('COMPLETED', 'IN_ERROR')
       LIMIT 1`
    )
    .get() as GameRow | undefined;
}
