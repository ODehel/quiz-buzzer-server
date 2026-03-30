/**
 * Repository d'accès à la table T_QUESTION_QST.
 * Reçoit l'instance DB par injection (pas d'import global).
 */

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ id, type, themeId, title, choiceA, choiceB, choiceC, choiceD,
 *           correctAnswer, level, timeLimit, points, createdAt }} q
 */
export function insertQuestion(db, q) {
  db.prepare(
    `INSERT INTO T_QUESTION_QST (
       QST_ID, QST_TYPE, QST_THEME_ID, QST_TITLE,
       QST_CHOICE_A, QST_CHOICE_B, QST_CHOICE_C, QST_CHOICE_D,
       QST_CORRECT_ANSWER, QST_LEVEL, QST_TIME_LIMIT, QST_POINTS, QST_CREATED_AT
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    q.id, q.type, q.themeId, q.title,
    q.choiceA ?? null, q.choiceB ?? null, q.choiceC ?? null, q.choiceD ?? null,
    q.correctAnswer, q.level, q.timeLimit, q.points, q.createdAt
  );
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @returns {Object|undefined}
 */
export function findQuestionById(db, id) {
  return db
    .prepare(
      `SELECT q.*, t.THM_NAME
       FROM T_QUESTION_QST q
       LEFT JOIN T_THEME_THM t ON t.THM_ID = q.QST_THEME_ID
       WHERE q.QST_ID = ?`
    )
    .get(id);
}

/**
 * Recherche une question par titre (insensible à la casse grâce à COLLATE NOCASE).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} title
 * @returns {Object|undefined}
 */
export function findQuestionByTitle(db, title) {
  return db
    .prepare("SELECT QST_ID, QST_TITLE FROM T_QUESTION_QST WHERE QST_TITLE = ?")
    .get(title);
}

/**
 * Liste les questions avec pagination et filtrage.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {Object} filters
 * @param {number} page
 * @param {number} limit
 * @returns {{ data: Array, total: number }}
 */
export function findQuestions(db, filters, page, limit) {
  const conditions = [];
  const params = [];

  if (filters.theme_id !== undefined) {
    conditions.push("QST_THEME_ID = ?");
    params.push(filters.theme_id);
  }
  if (filters.type !== undefined) {
    conditions.push("QST_TYPE = ?");
    params.push(filters.type);
  }
  if (filters.level !== undefined) {
    conditions.push("QST_LEVEL = ?");
    params.push(filters.level);
  }
  if (filters.level_min !== undefined) {
    conditions.push("QST_LEVEL >= ?");
    params.push(filters.level_min);
  }
  if (filters.level_max !== undefined) {
    conditions.push("QST_LEVEL <= ?");
    params.push(filters.level_max);
  }
  if (filters.time_limit_min !== undefined) {
    conditions.push("QST_TIME_LIMIT >= ?");
    params.push(filters.time_limit_min);
  }
  if (filters.time_limit_max !== undefined) {
    conditions.push("QST_TIME_LIMIT <= ?");
    params.push(filters.time_limit_max);
  }
  if (filters.points_min !== undefined) {
    conditions.push("QST_POINTS >= ?");
    params.push(filters.points_min);
  }
  if (filters.points_max !== undefined) {
    conditions.push("QST_POINTS <= ?");
    params.push(filters.points_max);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const total = db
    .prepare(`SELECT COUNT(*) AS count FROM T_QUESTION_QST ${where}`)
    .get(...params).count;

  const offset = (page - 1) * limit;
  const data = db
    .prepare(
      `SELECT q.*, t.THM_NAME
       FROM T_QUESTION_QST q
       LEFT JOIN T_THEME_THM t ON t.THM_ID = q.QST_THEME_ID
       ${where} ORDER BY q.QST_ID DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  return { data, total };
}

/**
 * Met à jour les champs d'une question.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @param {Object} fields - Champs à mettre à jour (clés camelCase)
 * @param {string} lastUpdatedAt
 */
export function updateQuestion(db, id, fields, lastUpdatedAt) {
  const columnMap = {
    themeId: "QST_THEME_ID",
    title: "QST_TITLE",
    choiceA: "QST_CHOICE_A",
    choiceB: "QST_CHOICE_B",
    choiceC: "QST_CHOICE_C",
    choiceD: "QST_CHOICE_D",
    correctAnswer: "QST_CORRECT_ANSWER",
    level: "QST_LEVEL",
    timeLimit: "QST_TIME_LIMIT",
    points: "QST_POINTS",
    imagePath: "QST_IMAGE_PATH",
    audioPath: "QST_AUDIO_PATH",
  };

  const setClauses = [];
  const params = [];

  for (const [key, column] of Object.entries(columnMap)) {
    if (key in fields) {
      setClauses.push(`${column} = ?`);
      params.push(fields[key] ?? null);
    }
  }

  setClauses.push("QST_LAST_UPDATED_AT = ?");
  params.push(lastUpdatedAt);
  params.push(id);

  db.prepare(
    `UPDATE T_QUESTION_QST SET ${setClauses.join(", ")} WHERE QST_ID = ?`
  ).run(...params);
}

/**
 * Supprime une question par son ID.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @returns {number} Nombre de lignes supprimées
 */
export function deleteQuestion(db, id) {
  return db.prepare("DELETE FROM T_QUESTION_QST WHERE QST_ID = ?").run(id).changes;
}

/**
 * Insère plusieurs questions en une seule transaction atomique.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {Array<{ id, type, themeId, title, choiceA, choiceB, choiceC, choiceD,
 *                 correctAnswer, level, timeLimit, points, createdAt }>} questions
 */
export function insertQuestions(db, questions) {
  const stmt = db.prepare(
    `INSERT INTO T_QUESTION_QST (
       QST_ID, QST_TYPE, QST_THEME_ID, QST_TITLE,
       QST_CHOICE_A, QST_CHOICE_B, QST_CHOICE_C, QST_CHOICE_D,
       QST_CORRECT_ANSWER, QST_LEVEL, QST_TIME_LIMIT, QST_POINTS, QST_CREATED_AT
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertAll = db.transaction((qs) => {
    for (const q of qs) {
      stmt.run(
        q.id, q.type, q.themeId, q.title,
        q.choiceA ?? null, q.choiceB ?? null, q.choiceC ?? null, q.choiceD ?? null,
        q.correctAnswer, q.level, q.timeLimit, q.points, q.createdAt
      );
    }
  });

  insertAll(questions);
}

/**
 * Compte les questions associées à un thème (pour la garde de suppression CA-30 de l'US-003).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} themeId
 * @returns {number}
 */
export function countQuestionsByTheme(db, themeId) {
  return db
    .prepare("SELECT COUNT(*) AS count FROM T_QUESTION_QST WHERE QST_THEME_ID = ?")
    .get(themeId).count;
}