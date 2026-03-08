/**
 * Repository d'accès à la table T_THEME_THM.
 * Reçoit l'instance DB par injection (pas d'import global).
 */

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ id: string, name: string, createdAt: string }} theme
 */
export function insertTheme(db, { id, name, createdAt }) {
  db.prepare(
    `INSERT INTO T_THEME_THM (THM_ID, THM_NAME, THM_CREATED_AT)
     VALUES (?, ?, ?)`
  ).run(id, name, createdAt);
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @returns {{ THM_ID: string, THM_NAME: string, THM_CREATED_AT: string, THM_LAST_UPDATED_AT: string|null } | undefined}
 */
export function findById(db, id) {
  return db
    .prepare("SELECT THM_ID, THM_NAME, THM_CREATED_AT, THM_LAST_UPDATED_AT FROM T_THEME_THM WHERE THM_ID = ?")
    .get(id);
}

/**
 * Recherche un thème par nom (insensible à la casse grâce à COLLATE NOCASE).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} name
 * @returns {{ THM_ID: string, THM_NAME: string } | undefined}
 */
export function findByName(db, name) {
  return db
    .prepare("SELECT THM_ID, THM_NAME FROM T_THEME_THM WHERE THM_NAME = ?")
    .get(name);
}

/**
 * Liste les thèmes avec pagination, triés par ID descendant.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {number} page
 * @param {number} limit
 * @returns {{ data: Array, total: number }}
 */
export function findAll(db, page, limit) {
  const total = db.prepare("SELECT COUNT(*) AS count FROM T_THEME_THM").get().count;
  const offset = (page - 1) * limit;
  const data = db
    .prepare(
      `SELECT THM_ID, THM_NAME, THM_CREATED_AT, THM_LAST_UPDATED_AT
       FROM T_THEME_THM
       ORDER BY THM_ID DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
  return { data, total };
}

/**
 * Met à jour le nom d'un thème et son horodatage de modification.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @param {string} name
 * @param {string} lastUpdatedAt
 */
export function updateTheme(db, id, name, lastUpdatedAt) {
  db.prepare(
    `UPDATE T_THEME_THM
     SET THM_NAME = ?, THM_LAST_UPDATED_AT = ?
     WHERE THM_ID = ?`
  ).run(name, lastUpdatedAt, id);
}

/**
 * Supprime un thème par son ID.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @returns {number} Nombre de lignes supprimées
 */
export function deleteTheme(db, id) {
  return db.prepare("DELETE FROM T_THEME_THM WHERE THM_ID = ?").run(id).changes;
}