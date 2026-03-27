/**
 * Repository d'accès aux tables T_GAME_GAM et T_GAME_PARTICIPANT_GPA.
 * Reçoit l'instance DB par injection (DIP — pas d'import global).
 */

/**
 * Insère une nouvelle partie (statut PENDING par défaut).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ id: string, quizId: string, createdAt: string }} game
 */
export function insertGame(db, { id, quizId, createdAt }) {
  db.prepare(
    `INSERT INTO T_GAME_GAM (GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT)
     VALUES (?, ?, 'PENDING', ?)`
  ).run(id, quizId, createdAt);
}

/**
 * Insère les participants d'une partie (ordre 1-based).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} gameId
 * @param {string[]} names - Tableau ordonné de noms
 */
export function insertParticipants(db, gameId, names) {
  const stmt = db.prepare(
    `INSERT INTO T_GAME_PARTICIPANT_GPA (GPA_GAME_ID, GPA_NAME, GPA_ORDER)
     VALUES (?, ?, ?)`
  );
  names.forEach((name, index) => {
    stmt.run(gameId, name, index + 1);
  });
}

/**
 * Retourne une partie par son ID.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @returns {{ GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT, GAM_LAST_UPDATED_AT } | undefined}
 */
export function findGameById(db, id) {
  return db
    .prepare(
      `SELECT GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT, GAM_LAST_UPDATED_AT
       FROM T_GAME_GAM WHERE GAM_ID = ?`
    )
    .get(id);
}

/**
 * Retourne les participants d'une partie, triés par ordre croissant.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} gameId
 * @returns {Array<{ GPA_ORDER: number, GPA_NAME: string }>}
 */
export function findParticipantsByGameId(db, gameId) {
  return db
    .prepare(
      `SELECT GPA_ORDER, GPA_NAME FROM T_GAME_PARTICIPANT_GPA
       WHERE GPA_GAME_ID = ? ORDER BY GPA_ORDER`
    )
    .all(gameId);
}

/**
 * Retourne toutes les parties, triées par date de création décroissante.
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {Array<{ GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT, GAM_LAST_UPDATED_AT }>}
 */
export function findAllGames(db) {
  return db
    .prepare(
      `SELECT GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT, GAM_LAST_UPDATED_AT
       FROM T_GAME_GAM ORDER BY GAM_CREATED_AT DESC`
    )
    .all();
}

/**
 * Retourne les parties avec pagination, triées par date de création décroissante.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {number} page
 * @param {number} limit
 * @returns {{ data: Array<{ GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT, GAM_LAST_UPDATED_AT }>, total: number }}
 */
export function findAllGamesPaginated(db, page, limit) {
  const total = db.prepare("SELECT COUNT(*) AS count FROM T_GAME_GAM").get().count;
  const offset = (page - 1) * limit;
  const data = db
    .prepare(
      `SELECT GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT, GAM_LAST_UPDATED_AT
       FROM T_GAME_GAM
       ORDER BY GAM_CREATED_AT DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
  return { data, total };
}

/**
 * Retourne le nombre de parties actives (tous les états sauf COMPLETED ou IN_ERROR, cf. US-011).
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {number}
 */
export function countActiveGames(db) {
  return db
    .prepare(
      `SELECT COUNT(*) AS count FROM T_GAME_GAM
       WHERE GAM_STATUS NOT IN ('COMPLETED', 'IN_ERROR')`
    )
    .get().count;
}

/**
 * Met à jour le statut d'une partie.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @param {string} status
 */
export function updateGameStatus(db, id, status) {
  db.prepare(`UPDATE T_GAME_GAM SET GAM_STATUS = ? WHERE GAM_ID = ?`).run(status, id);
}

/**
 * Met à jour l'horodatage de modification d'une partie.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @param {string} lastUpdatedAt
 */
export function updateGameLastUpdated(db, id, lastUpdatedAt) {
  db.prepare(`UPDATE T_GAME_GAM SET GAM_LAST_UPDATED_AT = ? WHERE GAM_ID = ?`).run(lastUpdatedAt, id);
}

/**
 * Supprime tous les participants d'une partie.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} gameId
 */
export function deleteParticipantsByGameId(db, gameId) {
  db.prepare(`DELETE FROM T_GAME_PARTICIPANT_GPA WHERE GPA_GAME_ID = ?`).run(gameId);
}

/**
 * Retourne un participant par son ordre dans une partie.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} gameId
 * @param {number} order
 * @returns {{ GPA_ORDER: number, GPA_NAME: string } | undefined}
 */
export function findParticipantByOrder(db, gameId, order) {
  return db
    .prepare(
      `SELECT GPA_ORDER, GPA_NAME FROM T_GAME_PARTICIPANT_GPA
       WHERE GPA_GAME_ID = ? AND GPA_ORDER = ?`
    )
    .get(gameId, order);
}

/**
 * Met à jour le nom d'un participant.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} gameId
 * @param {number} order
 * @param {string} name
 */
export function updateParticipantName(db, gameId, order, name) {
  db.prepare(
    `UPDATE T_GAME_PARTICIPANT_GPA SET GPA_NAME = ?
     WHERE GPA_GAME_ID = ? AND GPA_ORDER = ?`
  ).run(name, gameId, order);
}

/**
 * Supprime une partie (les participants sont supprimés en cascade).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @returns {number} Nombre de lignes supprimées (0 ou 1)
 */
export function deleteGameById(db, id) {
  return db.prepare(`DELETE FROM T_GAME_GAM WHERE GAM_ID = ?`).run(id).changes;
}
