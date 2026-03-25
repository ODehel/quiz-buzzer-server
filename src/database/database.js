import Database from "better-sqlite3";
import path from "node:path";

const DEFAULT_DB_PATH = process.env.DATABASE_PATH ?? path.resolve("quiz-buzzer.db");

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

  CREATE TABLE IF NOT EXISTS T_QUESTION_QST
  (
      QST_ID              TEXT PRIMARY KEY,
      QST_TYPE            TEXT NOT NULL CHECK (QST_TYPE IN ('MCQ', 'SPEED')),
      QST_THEME_ID        TEXT NOT NULL REFERENCES T_THEME_THM (THM_ID),
      QST_TITLE           TEXT NOT NULL UNIQUE COLLATE NOCASE,
      QST_CHOICE_A        TEXT DEFAULT NULL,
      QST_CHOICE_B        TEXT DEFAULT NULL,
      QST_CHOICE_C        TEXT DEFAULT NULL,
      QST_CHOICE_D        TEXT DEFAULT NULL,
      QST_CORRECT_ANSWER  TEXT NOT NULL,
      QST_LEVEL           INTEGER NOT NULL CHECK (QST_LEVEL BETWEEN 1 AND 5),
      QST_TIME_LIMIT      INTEGER NOT NULL CHECK (QST_TIME_LIMIT BETWEEN 5 AND 60),
      QST_POINTS          INTEGER NOT NULL CHECK (QST_POINTS BETWEEN 1 AND 50),
      QST_IMAGE_PATH      TEXT DEFAULT NULL,
      QST_AUDIO_PATH      TEXT DEFAULT NULL,
      QST_CREATED_AT      TEXT NOT NULL,
      QST_LAST_UPDATED_AT TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS T_QUIZ_QUZ
  (
      QUZ_ID              TEXT PRIMARY KEY,
      QUZ_NAME            TEXT NOT NULL UNIQUE COLLATE NOCASE,
      QUZ_CREATED_AT      TEXT NOT NULL,
      QUZ_LAST_UPDATED_AT TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS T_QUIZ_QUESTION_QQN
  (
      QQN_QUIZ_ID     TEXT    NOT NULL REFERENCES T_QUIZ_QUZ (QUZ_ID),
      QQN_QUESTION_ID TEXT    NOT NULL REFERENCES T_QUESTION_QST (QST_ID),
      QQN_ORDER       INTEGER NOT NULL,
      PRIMARY KEY (QQN_QUIZ_ID, QQN_ORDER)
  );

  -- T_GAME_GAM: Table pour gérer l'état des parties
  --
  -- REMARQUE IMPORTANTE — Initialisation préventive des états dans le CHECK:
  -- La contrainte CHECK sur GAM_STATUS inclut TOUS les états de la machine à états complète,
  -- initialisés d'emblée pour éviter deux recréations destructives de table lors des migrations
  -- ultérieures (ALT ER COLUMN n'est pas supporté par SQLite).
  --
  -- États initialisés:
  -- - Partie (US-010): PENDING, OPEN, COMPLETED, IN_ERROR
  -- - Question MCQ (US-011): QUESTION_TITLE, QUESTION_OPEN, QUESTION_CLOSED, QUESTION_BUZZED
  -- - États SPEED (US-012): à documenter à la mise en œuvre
  CREATE TABLE IF NOT EXISTS T_GAME_GAM
  (
      GAM_ID                      TEXT PRIMARY KEY,
      GAM_QUIZ_ID                 TEXT NOT NULL REFERENCES T_QUIZ_QUZ (QUZ_ID),
      GAM_STATUS                  TEXT NOT NULL DEFAULT 'PENDING'
                                      CHECK (GAM_STATUS IN ('PENDING', 'OPEN', 'QUESTION_TITLE', 'QUESTION_OPEN', 'QUESTION_BUZZED', 'QUESTION_CLOSED', 'COMPLETED', 'IN_ERROR')),
      GAM_CURRENT_QUESTION_INDEX  INTEGER NOT NULL DEFAULT 0,
      GAM_CREATED_AT              TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS T_GAME_PARTICIPANT_GPA
  (
      GPA_GAME_ID TEXT    NOT NULL REFERENCES T_GAME_GAM (GAM_ID) ON DELETE CASCADE,
      GPA_NAME    TEXT    NOT NULL,
      GPA_ORDER   INTEGER NOT NULL CHECK (GPA_ORDER BETWEEN 1 AND 10),
      PRIMARY KEY (GPA_GAME_ID, GPA_ORDER),
      UNIQUE (GPA_GAME_ID, GPA_NAME)
  );

  CREATE TABLE IF NOT EXISTS T_GAME_ANSWER_GAA
  (
      GAA_ID                TEXT    PRIMARY KEY,
      GAA_GAME_ID           TEXT    NOT NULL REFERENCES T_GAME_GAM (GAM_ID) ON DELETE CASCADE,
      GAA_QUESTION_ID       TEXT    NOT NULL REFERENCES T_QUESTION_QST (QST_ID),
      GAA_PARTICIPANT_ORDER INTEGER NOT NULL,
      GAA_ANSWER            TEXT    DEFAULT NULL,
      GAA_TIME_MS           INTEGER NOT NULL,
      GAA_POINTS_EARNED     INTEGER NOT NULL DEFAULT 0,
      GAA_CUMULATIVE_SCORE  INTEGER NOT NULL DEFAULT 0,
      GAA_CREATED_AT        TEXT    NOT NULL,
      UNIQUE (GAA_GAME_ID, GAA_QUESTION_ID, GAA_PARTICIPANT_ORDER)
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