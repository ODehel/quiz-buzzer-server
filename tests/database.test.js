import { openDatabase } from "../src/database/database.js";

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
    // Appel sans argument → crée quiz-buzzer.db sur le filesystem
    const db = openDatabase();

    try {
      expect(db.open).toBe(true);
    } finally {
      db.close();
      // Nettoyage du fichier créé (y compris fichiers WAL/SHM annexes)
      const fs = await import("node:fs");
      for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(`quiz-buzzer.db${suffix}`); } catch { /* ignore */ }
      }
    }
  });
});