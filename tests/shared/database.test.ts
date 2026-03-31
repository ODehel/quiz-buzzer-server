import path from "node:path";
import os from "node:os";
import { openDatabase } from "../../src/database/database.ts";

describe("openDatabase", () => {
  it("should open an in-memory database with the T_USER_USR table", () => {
    const db = openDatabase(":memory:");

    try {
      // Vérifie que la table existe en insérant une ligne
      const stmt = db.prepare(
        `INSERT INTO T_USER_USR (USR_ID, USR_USERNAME, USR_PASSWORD, USR_ROLE, USR_CREATED_AT)
         VALUES (?, ?, ?, ?, ?)`
      );
      stmt.run("id-1", "testuser", "hashedpwd", "admin", "2026-01-01T00:00:00.000Z");

      const row = db.prepare("SELECT * FROM T_USER_USR WHERE USR_ID = ?").get("id-1");
      expect(row.USR_USERNAME).toBe("testuser");
      expect(row.USR_ROLE).toBe("admin");
    } finally {
      db.close();
    }
  });

  it("should enforce the CHECK constraint on USR_ROLE", () => {
    const db = openDatabase(":memory:");

    try {
      expect(() =>
        db.prepare(
          `INSERT INTO T_USER_USR (USR_ID, USR_USERNAME, USR_PASSWORD, USR_ROLE, USR_CREATED_AT)
           VALUES (?, ?, ?, ?, ?)`
        ).run("id-2", "baduser", "pwd", "superadmin", "2026-01-01T00:00:00.000Z")
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("should enforce UNIQUE COLLATE NOCASE on USR_USERNAME", () => {
    const db = openDatabase(":memory:");

    try {
      const stmt = db.prepare(
        `INSERT INTO T_USER_USR (USR_ID, USR_USERNAME, USR_PASSWORD, USR_ROLE, USR_CREATED_AT)
         VALUES (?, ?, ?, ?, ?)`
      );
      stmt.run("id-3", "Admin", "pwd", "admin", "2026-01-01T00:00:00.000Z");

      expect(() =>
        stmt.run("id-4", "admin", "pwd", "buzzer", "2026-01-01T00:00:00.000Z")
      ).toThrow();
    } finally {
      db.close();
    }
  });
  it("should use default path when no argument is provided", async () => {
    const originalPath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = path.resolve(os.tmpdir(), `quiz-buzzer-test-${Date.now()}.db`);

    const db = openDatabase();
    try {
      expect(db.open).toBe(true);
    } finally {
      db.close();
      const fs = await import("node:fs");
      const testPath = process.env.DATABASE_PATH;
      for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(`${testPath}${suffix}`); } catch { /* ignore */ }
      }
      if (originalPath === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = originalPath;
    }
  });

  it("should create T_QUIZ_QUZ table with correct constraints", () => {
    const db = openDatabase(":memory:");
    try {
      db.prepare(
        `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT)
       VALUES (?, ?, ?)`
      ).run("quiz-id-1", "Sciences exactes", "2026-03-13T10:00:00.000Z");

      const row = db.prepare("SELECT * FROM T_QUIZ_QUZ WHERE QUZ_ID = ?").get("quiz-id-1");
      expect(row.QUZ_NAME).toBe("Sciences exactes");
      expect(row.QUZ_LAST_UPDATED_AT).toBeNull();

      // UNIQUE COLLATE NOCASE
      expect(() =>
        db.prepare(
          `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT) VALUES (?, ?, ?)`
        ).run("quiz-id-2", "SCIENCES EXACTES", "2026-03-13T10:00:00.000Z")
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("should create T_QUIZ_QUESTION_QQN table with FK and composite PK", () => {
    const db = openDatabase(":memory:");
    try {
      // Insérer une question et un quiz d'abord
      db.prepare(
        `INSERT INTO T_THEME_THM (THM_ID, THM_NAME, THM_CREATED_AT) VALUES (?, ?, ?)`
      ).run("thm-1", "Science", "2026-03-13T10:00:00.000Z");
      db.prepare(
        `INSERT INTO T_QUESTION_QST (QST_ID, QST_TYPE, QST_THEME_ID, QST_TITLE,
         QST_CORRECT_ANSWER, QST_LEVEL, QST_TIME_LIMIT, QST_POINTS, QST_CREATED_AT)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("qst-1", "SPEED", "thm-1", "Quelle est la capitale de la France ?",
        "Paris", 1, 30, 5, "2026-03-13T10:00:00.000Z");
      db.prepare(
        `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT) VALUES (?, ?, ?)`
      ).run("quz-1", "Mon quiz", "2026-03-13T10:00:00.000Z");

      // Insérer la liaison
      db.prepare(
        `INSERT INTO T_QUIZ_QUESTION_QQN (QQN_QUIZ_ID, QQN_QUESTION_ID, QQN_ORDER)
       VALUES (?, ?, ?)`
      ).run("quz-1", "qst-1", 1);

      // PK composite : doublon (quiz_id, order) interdit
      expect(() =>
        db.prepare(
          `INSERT INTO T_QUIZ_QUESTION_QQN (QQN_QUIZ_ID, QQN_QUESTION_ID, QQN_ORDER)
         VALUES (?, ?, ?)`
        ).run("quz-1", "qst-1", 1)
      ).toThrow();

      // FK : question inexistante refusée
      expect(() =>
        db.prepare(
          `INSERT INTO T_QUIZ_QUESTION_QQN (QQN_QUIZ_ID, QQN_QUESTION_ID, QQN_ORDER)
         VALUES (?, ?, ?)`
        ).run("quz-1", "qst-inexistant", 2)
      ).toThrow();
    } finally {
      db.close();
    }
  });
});