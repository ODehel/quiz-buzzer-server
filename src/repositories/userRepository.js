/**
 * Repository d'accès à la table T_USER_USR.
 * Reçoit l'instance DB par injection (pas d'import global).
 */

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @returns {{ USR_ID: string, USR_USERNAME: string, USR_ROLE: string } | undefined}
 */
export function findById(db, id) {
  return db
    .prepare(
      "SELECT USR_ID, USR_USERNAME, USR_ROLE FROM T_USER_USR WHERE USR_ID = ?"
    )
    .get(id);
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} username
 * @returns {{ USR_ID: string, USR_USERNAME: string, USR_PASSWORD: string, USR_ROLE: string } | undefined}
 */
export function findByUsername(db, username) {
  return db
    .prepare(
      "SELECT USR_ID, USR_USERNAME, USR_PASSWORD, USR_ROLE FROM T_USER_USR WHERE USR_USERNAME = ?"
    )
    .get(username);
}

/**
 * @param {import("better-sqlite3").Database} db
 * @returns {number}
 */
export function countUsers(db) {
  return db.prepare("SELECT COUNT(*) AS count FROM T_USER_USR").get().count;
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ id: string, username: string, password: string, role: string, createdAt: string }} user
 */
export function insertUser(db, { id, username, password, role, createdAt }) {
  db.prepare(
    `INSERT INTO T_USER_USR (USR_ID, USR_USERNAME, USR_PASSWORD, USR_ROLE, USR_CREATED_AT)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, username, password, role, createdAt);
}