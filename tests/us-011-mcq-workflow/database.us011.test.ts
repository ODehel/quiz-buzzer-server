import { openDatabase } from "../../src/database/database.ts";

describe("US-011 — Database schema extensions", () => {
  let db;

  beforeEach(() => {
    db = openDatabase(":memory:");
    db.prepare(
      `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT) VALUES (?, ?, ?)`
    ).run("quiz-1", "Test Quiz", "2026-03-17T10:00:00.000Z");
});

  afterEach(() => db.close());

  // CA-2 : GAM_CURRENT_QUESTION_INDEX exists and defaults to 0
  describe("T_GAME_GAM — GAM_CURRENT_QUESTION_INDEX", () => {
    it("should default GAM_CURRENT_QUESTION_INDEX to 0 on insert", () => {
      db.prepare(
        `INSERT INTO T_GAME_GAM (GAM_ID, GAM_QUIZ_ID, GAM_CREATED_AT)
         VALUES (?, ?, ?)`
      ).run("gam-1", "quiz-1", "2026-03-17T10:00:00.000Z");

      const row = db.prepare("SELECT GAM_CURRENT_QUESTION_INDEX FROM T_GAME_GAM WHERE GAM_ID = ?").get("gam-1");
      expect(row.GAM_CURRENT_QUESTION_INDEX).toBe(0);
    });

    it("should allow updating GAM_CURRENT_QUESTION_INDEX", () => {
      db.prepare(
        `INSERT INTO T_GAME_GAM (GAM_ID, GAM_QUIZ_ID, GAM_CREATED_AT)
         VALUES (?, ?, ?)`
      ).run("gam-1", "quiz-1", "2026-03-17T10:00:00.000Z");

      db.prepare("UPDATE T_GAME_GAM SET GAM_CURRENT_QUESTION_INDEX = ? WHERE GAM_ID = ?").run(3, "gam-1");
      const row = db.prepare("SELECT GAM_CURRENT_QUESTION_INDEX FROM T_GAME_GAM WHERE GAM_ID = ?").get("gam-1");
      expect(row.GAM_CURRENT_QUESTION_INDEX).toBe(3);
    });
  });

  // CA-1 : Extended CHECK constraint on GAM_STATUS
  describe("T_GAME_GAM — Extended GAM_STATUS CHECK constraint", () => {
    const validStatuses = ["PENDING", "OPEN", "QUESTION_TITLE", "QUESTION_OPEN", "QUESTION_CLOSED", "COMPLETED", "IN_ERROR"];

    for (const status of validStatuses) {
      it(`should accept status '${status}'`, () => {
        expect(() =>
          db.prepare(
            `INSERT INTO T_GAME_GAM (GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT)
             VALUES (?, ?, ?, ?)`
          ).run(`gam-${status}`, "quiz-1", status, "2026-03-17T10:00:00.000Z")
        ).not.toThrow();
      });
    }

    it("should reject an invalid status", () => {
      expect(() =>
        db.prepare(
          `INSERT INTO T_GAME_GAM (GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT)
           VALUES (?, ?, ?, ?)`
        ).run("gam-bad", "quiz-1", "INVALID_STATUS", "2026-03-17T10:00:00.000Z")
      ).toThrow();
    });
  });

  // CA-32 : T_GAME_ANSWER_GAA table
  describe("T_GAME_ANSWER_GAA", () => {
    beforeEach(() => {
      // Insert prerequisite data
      db.prepare(
        `INSERT INTO T_THEME_THM (THM_ID, THM_NAME, THM_CREATED_AT) VALUES (?, ?, ?)`
      ).run("thm-1", "Science", "2026-03-17T10:00:00.000Z");

      db.prepare(
        `INSERT INTO T_QUESTION_QST (QST_ID, QST_TYPE, QST_THEME_ID, QST_TITLE,
         QST_CORRECT_ANSWER, QST_LEVEL, QST_TIME_LIMIT, QST_POINTS, QST_CREATED_AT)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("qst-1", "MCQ", "thm-1", "Quelle est la capitale ?", "Paris", 1, 30, 10, "2026-03-17T10:00:00.000Z");

      db.prepare(
        `INSERT INTO T_GAME_GAM (GAM_ID, GAM_QUIZ_ID, GAM_CREATED_AT)
         VALUES (?, ?, ?)`
      ).run("gam-1", "quiz-1", "2026-03-17T10:00:00.000Z");
    });

    it("should create T_GAME_ANSWER_GAA table and accept valid inserts", () => {
      db.prepare(
        `INSERT INTO T_GAME_ANSWER_GAA
         (GAA_ID, GAA_GAME_ID, GAA_QUESTION_ID, GAA_PARTICIPANT_ORDER,
          GAA_ANSWER, GAA_TIME_MS, GAA_POINTS_EARNED, GAA_CUMULATIVE_SCORE, GAA_CREATED_AT)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("gaa-1", "gam-1", "qst-1", 1, "A", 3100, 10, 10, "2026-03-17T10:00:30.000Z");

      const row = db.prepare("SELECT * FROM T_GAME_ANSWER_GAA WHERE GAA_ID = ?").get("gaa-1");
      expect(row.GAA_GAME_ID).toBe("gam-1");
      expect(row.GAA_QUESTION_ID).toBe("qst-1");
      expect(row.GAA_PARTICIPANT_ORDER).toBe(1);
      expect(row.GAA_ANSWER).toBe("A");
      expect(row.GAA_TIME_MS).toBe(3100);
      expect(row.GAA_POINTS_EARNED).toBe(10);
      expect(row.GAA_CUMULATIVE_SCORE).toBe(10);
    });

    // CA-33 : null answer for players who did not respond
    it("should allow null GAA_ANSWER for unanswered participants", () => {
      db.prepare(
        `INSERT INTO T_GAME_ANSWER_GAA
         (GAA_ID, GAA_GAME_ID, GAA_QUESTION_ID, GAA_PARTICIPANT_ORDER,
          GAA_ANSWER, GAA_TIME_MS, GAA_POINTS_EARNED, GAA_CUMULATIVE_SCORE, GAA_CREATED_AT)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("gaa-2", "gam-1", "qst-1", 2, null, 30000, 0, 0, "2026-03-17T10:00:30.000Z");

      const row = db.prepare("SELECT * FROM T_GAME_ANSWER_GAA WHERE GAA_ID = ?").get("gaa-2");
      expect(row.GAA_ANSWER).toBeNull();
      expect(row.GAA_POINTS_EARNED).toBe(0);
    });

    it("should enforce UNIQUE constraint on (game_id, question_id, participant_order)", () => {
      db.prepare(
        `INSERT INTO T_GAME_ANSWER_GAA
         (GAA_ID, GAA_GAME_ID, GAA_QUESTION_ID, GAA_PARTICIPANT_ORDER,
          GAA_ANSWER, GAA_TIME_MS, GAA_POINTS_EARNED, GAA_CUMULATIVE_SCORE, GAA_CREATED_AT)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("gaa-1", "gam-1", "qst-1", 1, "A", 3100, 10, 10, "2026-03-17T10:00:30.000Z");

      expect(() =>
        db.prepare(
          `INSERT INTO T_GAME_ANSWER_GAA
           (GAA_ID, GAA_GAME_ID, GAA_QUESTION_ID, GAA_PARTICIPANT_ORDER,
            GAA_ANSWER, GAA_TIME_MS, GAA_POINTS_EARNED, GAA_CUMULATIVE_SCORE, GAA_CREATED_AT)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run("gaa-dup", "gam-1", "qst-1", 1, "B", 5000, 0, 0, "2026-03-17T10:00:30.000Z")
      ).toThrow();
    });

    it("should cascade delete answers when game is deleted", () => {
      db.prepare(
        `INSERT INTO T_GAME_ANSWER_GAA
         (GAA_ID, GAA_GAME_ID, GAA_QUESTION_ID, GAA_PARTICIPANT_ORDER,
          GAA_ANSWER, GAA_TIME_MS, GAA_POINTS_EARNED, GAA_CUMULATIVE_SCORE, GAA_CREATED_AT)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("gaa-1", "gam-1", "qst-1", 1, "A", 3100, 10, 10, "2026-03-17T10:00:30.000Z");

      db.prepare("DELETE FROM T_GAME_GAM WHERE GAM_ID = ?").run("gam-1");

      const count = db.prepare("SELECT COUNT(*) AS c FROM T_GAME_ANSWER_GAA WHERE GAA_GAME_ID = ?").get("gam-1").c;
      expect(count).toBe(0);
    });

    it("should default GAA_POINTS_EARNED to 0", () => {
      db.prepare(
        `INSERT INTO T_GAME_ANSWER_GAA
         (GAA_ID, GAA_GAME_ID, GAA_QUESTION_ID, GAA_PARTICIPANT_ORDER,
          GAA_TIME_MS, GAA_CREATED_AT)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("gaa-3", "gam-1", "qst-1", 3, 30000, "2026-03-17T10:00:30.000Z");

      const row = db.prepare("SELECT GAA_POINTS_EARNED, GAA_CUMULATIVE_SCORE FROM T_GAME_ANSWER_GAA WHERE GAA_ID = ?").get("gaa-3");
      expect(row.GAA_POINTS_EARNED).toBe(0);
      expect(row.GAA_CUMULATIVE_SCORE).toBe(0);
    });
  });
});