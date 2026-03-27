/**
 * Repository d'accès à la table T_SOUND_SND.
 * Reçoit l'instance DB par injection (pas d'import global).
 */

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ id: string, name: string, filename: string, createdAt: string }} sound
 */
export function insertSound(db, { id, name, filename, createdAt }) {
  db.prepare(
    `INSERT INTO T_SOUND_SND (SND_ID, SND_NAME, SND_FILENAME, SND_CREATED_AT)
     VALUES (?, ?, ?, ?)`
  ).run(id, name, filename, createdAt);
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @returns {{ SND_ID: string, SND_NAME: string, SND_FILENAME: string, SND_CREATED_AT: string } | undefined}
 */
export function findSoundById(db, id) {
  return db
    .prepare("SELECT SND_ID, SND_NAME, SND_FILENAME, SND_CREATED_AT FROM T_SOUND_SND WHERE SND_ID = ?")
    .get(id);
}

/**
 * Recherche un son par nom (insensible à la casse grâce à COLLATE NOCASE).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} name
 * @returns {{ SND_ID: string, SND_NAME: string } | undefined}
 */
export function findSoundByName(db, name) {
  return db
    .prepare("SELECT SND_ID, SND_NAME FROM T_SOUND_SND WHERE SND_NAME = ?")
    .get(name);
}

/**
 * Liste les sons avec pagination, triés par ID descendant.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {number} page
 * @param {number} limit
 * @returns {{ data: Array, total: number }}
 */
export function findAllSounds(db, page, limit) {
  const total = db.prepare("SELECT COUNT(*) AS count FROM T_SOUND_SND").get().count;
  const offset = (page - 1) * limit;
  const data = db
    .prepare(
      `SELECT SND_ID, SND_NAME, SND_FILENAME, SND_CREATED_AT
       FROM T_SOUND_SND
       ORDER BY SND_ID DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
  return { data, total };
}

/**
 * Supprime un son par son ID.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @returns {number} Nombre de lignes supprimées
 */
export function deleteSound(db, id) {
  return db.prepare("DELETE FROM T_SOUND_SND WHERE SND_ID = ?").run(id).changes;
}
