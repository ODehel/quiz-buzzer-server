/**
 * Repository d'accès aux tables T_GAME_ANSWER_GAA et aux champs
 * liés au workflow de la partie dans T_GAME_GAM.
 * Reçoit l'instance DB par injection (DIP — pas d'import global).
 */

/**
 * Insère une réponse individuelle.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ id: string, gameId: string, questionId: string, participantOrder: number,
 *           answer: string|null, timeMs: number, pointsEarned: number,
 *           cumulativeScore: number, createdAt: string }} answer
 */
export function insertGameAnswer(db, answer) {
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
 *
 * @param {import("better-sqlite3").Database} db
 * @param {Array} answers - Tableau d'objets avec la même structure que insertGameAnswer
 */
export function insertGameAnswers(db, answers) {
  const stmt = db.prepare(
    `INSERT INTO T_GAME_ANSWER_GAA
       (GAA_ID, GAA_GAME_ID, GAA_QUESTION_ID, GAA_PARTICIPANT_ORDER,
        GAA_ANSWER, GAA_TIME_MS, GAA_POINTS_EARNED, GAA_CUMULATIVE_SCORE, GAA_CREATED_AT)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertAll = db.transaction((items) => {
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
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} gameId
 * @param {string} questionId
 * @returns {Array}
 */
export function findAnswersByGameAndQuestion(db, gameId, questionId) {
  return db
    .prepare(
      `SELECT * FROM T_GAME_ANSWER_GAA
       WHERE GAA_GAME_ID = ? AND GAA_QUESTION_ID = ?
       ORDER BY GAA_PARTICIPANT_ORDER`
    )
    .all(gameId, questionId);
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
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} gameId
 * @returns {Array} Rows ordered by GAA_QUESTION_ID, then GAA_PARTICIPANT_ORDER (sparse for SPEED)
 */
export function findAnswersByGame(db, gameId) {
  return db
    .prepare(
      `SELECT * FROM T_GAME_ANSWER_GAA
       WHERE GAA_GAME_ID = ?
       ORDER BY GAA_QUESTION_ID, GAA_PARTICIPANT_ORDER`
    )
    .all(gameId);
}

/**
 * Retourne le score cumulé le plus récent d'un participant dans une partie.
 * Retourne 0 si aucune réponse n'existe encore.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} gameId
 * @param {number} participantOrder
 * @returns {number}
 */
export function getCumulativeScore(db, gameId, participantOrder) {
  const row = db
    .prepare(
      `SELECT GAA_CUMULATIVE_SCORE FROM T_GAME_ANSWER_GAA
       WHERE GAA_GAME_ID = ? AND GAA_PARTICIPANT_ORDER = ?
       ORDER BY GAA_CREATED_AT DESC
       LIMIT 1`
    )
    .get(gameId, participantOrder);

  return row ? row.GAA_CUMULATIVE_SCORE : 0;
}

/**
 * Met à jour l'index de la question courante d'une partie (CA-2).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} gameId
 * @param {number} questionIndex
 */
export function updateGameQuestionIndex(db, gameId, questionIndex) {
  db.prepare(
    `UPDATE T_GAME_GAM SET GAM_CURRENT_QUESTION_INDEX = ? WHERE GAM_ID = ?`
  ).run(questionIndex, gameId);
}

/**
 * Retourne la partie active (tout état sauf COMPLETED et IN_ERROR).
 * Il ne peut y avoir qu'une seule partie active à la fois (contrainte US-010).
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {{ GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CURRENT_QUESTION_INDEX, GAM_CREATED_AT } | undefined}
 */
export function findActiveGame(db) {
  return db
    .prepare(
      `SELECT GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CURRENT_QUESTION_INDEX, GAM_CREATED_AT
       FROM T_GAME_GAM
       WHERE GAM_STATUS NOT IN ('COMPLETED', 'IN_ERROR')
       LIMIT 1`
    )
    .get();
}