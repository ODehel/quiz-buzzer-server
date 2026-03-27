/**
 * Repository for T_SOUND_SND (jingles — US-017).
 * All functions receive the DB instance by injection (DIP).
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
 * @returns {Object|undefined}
 */
export function findSoundById(db, id) {
  return db.prepare(`SELECT * FROM T_SOUND_SND WHERE SND_ID = ?`).get(id);
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} name
 * @returns {Object|undefined}
 */
export function findSoundByName(db, name) {
  return db.prepare(`SELECT * FROM T_SOUND_SND WHERE SND_NAME = ?`).get(name);
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {number} page
 * @param {number} limit
 * @returns {{ data: Object[], total: number }}
 */
export function findSounds(db, page, limit) {
  const offset = (page - 1) * limit;
  const total = db.prepare(`SELECT COUNT(*) AS count FROM T_SOUND_SND`).get().count;
  const data = db
    .prepare(`SELECT * FROM T_SOUND_SND ORDER BY SND_CREATED_AT DESC LIMIT ? OFFSET ?`)
    .all(limit, offset);
  return { data, total };
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @returns {number} Number of rows deleted
 */
export function deleteSoundById(db, id) {
  return db.prepare(`DELETE FROM T_SOUND_SND WHERE SND_ID = ?`).run(id).changes;
}
