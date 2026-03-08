import Database from "better-sqlite3";
import path from "node:path";

const DEFAULT_DB_PATH = path.resolve("quiz-buzzer.db");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS T_USER_USR
  (
      USR_ID              TEXT PRIMARY KEY,
      USR_USERNAME        TEXT NOT NULL UNIQUE COLLATE NOCASE,
      USR_PASSWORD        TEXT NOT NULL,
      USR_ROLE            TEXT NOT NULL DEFAULT 'buzzer' CHECK (USR_ROLE IN ('admin', 'buzzer')),
      USR_CREATED_AT      TEXT NOT NULL,
      USR_LAST_UPDATED_AT TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS T_THEME_THM
  (
      THM_ID              TEXT PRIMARY KEY,
      THM_NAME            TEXT NOT NULL UNIQUE COLLATE NOCASE,
      THM_CREATED_AT      TEXT NOT NULL,
      THM_LAST_UPDATED_AT TEXT DEFAULT NULL
  );
`;

/**
 * Ouvre (ou crée) une base SQLite et initialise le schéma.
 *
 * @param {string} [dbPath] - chemin du fichier DB (défaut : quiz-buzzer.db).
 *                             Passer ":memory:" pour les tests.
 * @returns {import("better-sqlite3").Database}
 */
export function openDatabase(dbPath = DEFAULT_DB_PATH) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}