/**
 * Repository d'accès aux tables T_QUIZ_QUZ et T_QUIZ_QUESTION_QQN.
 * Reçoit l'instance DB par injection (DIP — pas d'import global).
 */

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ id: string, name: string, createdAt: string }} quiz
 */
export function insertQuiz(db, { id, name, createdAt }) {
  db.prepare(
    `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT)
     VALUES (?, ?, ?)`
  ).run(id, name, createdAt);
}

/**
 * Insère les liaisons quiz-questions avec leur ordre (CA-9).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} quizId
 * @param {string[]} questionIds - Tableau ordonné d'IDs
 */
export function insertQuizQuestions(db, quizId, questionIds) {
  const stmt = db.prepare(
    `INSERT INTO T_QUIZ_QUESTION_QQN (QQN_QUIZ_ID, QQN_QUESTION_ID, QQN_ORDER)
     VALUES (?, ?, ?)`
  );
  // Utiliser une transaction pour garantir l'atomicité
  const insertAll = db.transaction((ids) => {
    ids.forEach((qstId, index) => {
      stmt.run(quizId, qstId, index + 1);
    });
  });
  insertAll(questionIds);
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @returns {{ QUZ_ID, QUZ_NAME, QUZ_CREATED_AT, QUZ_LAST_UPDATED_AT } | undefined}
 */
export function findQuizById(db, id) {
  return db
    .prepare(
      `SELECT QUZ_ID, QUZ_NAME, QUZ_CREATED_AT, QUZ_LAST_UPDATED_AT
       FROM T_QUIZ_QUZ WHERE QUZ_ID = ?`
    )
    .get(id);
}

/**
 * Recherche un quiz par nom (insensible à la casse grâce à COLLATE NOCASE).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} name
 * @returns {{ QUZ_ID, QUZ_NAME } | undefined}
 */
export function findQuizByName(db, name) {
  return db
    .prepare(`SELECT QUZ_ID, QUZ_NAME FROM T_QUIZ_QUZ WHERE QUZ_NAME = ?`)
    .get(name);
}

/**
 * Liste tous les quiz avec leur question_summary, triés par création décroissante.
 * Filtre optionnel par nom (contient, insensible à la casse) — CA-17, CA-18, CA-19.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string|null} nameFilter
 * @returns {Array}
 */
export function findAllQuizzes(db, nameFilter) {
  const whereClause = nameFilter
    ? `WHERE LOWER(q.QUZ_NAME) LIKE LOWER(?)`
    : "";
  const params = nameFilter ? [`%${nameFilter}%`] : [];

  const quizRows = db
    .prepare(
      `SELECT q.QUZ_ID, q.QUZ_NAME, q.QUZ_CREATED_AT, q.QUZ_LAST_UPDATED_AT
       FROM T_QUIZ_QUZ q
       ${whereClause}
       ORDER BY q.QUZ_CREATED_AT DESC`
    )
    .all(...params);

  if (quizRows.length === 0) return [];

  // Calcul du question_summary pour chaque quiz via une jointure (CA-19)
  const summaryStmt = db.prepare(
    `SELECT qst.QST_LEVEL AS level, qst.QST_TYPE AS type, COUNT(*) AS count
     FROM T_QUIZ_QUESTION_QQN qqn
     JOIN T_QUESTION_QST qst ON qst.QST_ID = qqn.QQN_QUESTION_ID
     WHERE qqn.QQN_QUIZ_ID = ?
     GROUP BY qst.QST_LEVEL, qst.QST_TYPE`
  );

  return quizRows.map((row) => {
    const summaryRows = summaryStmt.all(row.QUZ_ID);
    const by_level = buildByLevel(summaryRows);
    const total = summaryRows.reduce((sum, r) => sum + r.count, 0);

    return {
      id: row.QUZ_ID,
      name: row.QUZ_NAME,
      created_at: row.QUZ_CREATED_AT,
      last_updated_at: row.QUZ_LAST_UPDATED_AT ?? null,
      question_summary: { total, by_level },
    };
  });
}

/**
 * Construit la structure by_level à partir des rows SQL agrégées.
 * Garantit la présence de tous les niveaux 1-5 (même à 0).
 *
 * @param {Array<{ level: number, type: string, count: number }>} rows
 * @returns {Object}
 */
function buildByLevel(rows) {
  const by_level = {};
  for (let lvl = 1; lvl <= 5; lvl++) {
    by_level[String(lvl)] = { MCQ: 0, SPEED: 0 };
  }
  for (const { level, type, count } of rows) {
    by_level[String(level)][type] = count;
  }
  return by_level;
}

/**
 * Retourne les IDs de questions d'un quiz, triés par QQN_ORDER (CA-9).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} quizId
 * @returns {string[]}
 */
export function getQuizQuestionIds(db, quizId) {
  return db
    .prepare(
      `SELECT QQN_QUESTION_ID FROM T_QUIZ_QUESTION_QQN
       WHERE QQN_QUIZ_ID = ? ORDER BY QQN_ORDER`
    )
    .all(quizId)
    .map((r) => r.QQN_QUESTION_ID);
}

/**
 * Met à jour le nom d'un quiz et son horodatage de modification.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @param {string} name
 * @param {string} lastUpdatedAt
 */
export function updateQuiz(db, id, name, lastUpdatedAt) {
  db.prepare(
    `UPDATE T_QUIZ_QUZ
     SET QUZ_NAME = ?, QUZ_LAST_UPDATED_AT = ?
     WHERE QUZ_ID = ?`
  ).run(name, lastUpdatedAt, id);
}

/**
 * Supprime toutes les liaisons quiz-questions d'un quiz (pour le PUT en transaction).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} quizId
 */
export function deleteQuizQuestions(db, quizId) {
  db.prepare(
    `DELETE FROM T_QUIZ_QUESTION_QQN WHERE QQN_QUIZ_ID = ?`
  ).run(quizId);
}

/**
 * Supprime un quiz.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @returns {number} Nombre de lignes supprimées (0 ou 1)
 */
export function deleteQuiz(db, id) {
  return db.prepare(`DELETE FROM T_QUIZ_QUZ WHERE QUZ_ID = ?`).run(id).changes;
}

/**
 * Compte le nombre de quiz qui utilisent une question donnée (CA-36).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} questionId
 * @returns {number}
 */
export function countQuizzesByQuestion(db, questionId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS count FROM T_QUIZ_QUESTION_QQN WHERE QQN_QUESTION_ID = ?`
    )
    .get(questionId).count;
}