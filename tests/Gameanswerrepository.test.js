import { openDatabase } from "../src/database/database.js";
import {
  insertGameAnswer,
  insertGameAnswers,
  findAnswersByGameAndQuestion,
  findAnswersByGame,
  getCumulativeScore,
  updateGameQuestionIndex,
  findActiveGame,
} from "../src/repositories/gameAnswerRepository.js";

function createTestDb() {
  const db = openDatabase(":memory:");

  // Theme
  db.prepare(
    `INSERT INTO T_THEME_THM (THM_ID, THM_NAME, THM_CREATED_AT) VALUES (?, ?, ?)`
  ).run("thm-1", "Science", "2026-03-17T10:00:00.000Z");

  // Questions
  for (let i = 1; i <= 3; i++) {
    db.prepare(
      `INSERT INTO T_QUESTION_QST
         (QST_ID, QST_TYPE, QST_THEME_ID, QST_TITLE,
          QST_CHOICE_A, QST_CHOICE_B, QST_CHOICE_C, QST_CHOICE_D,
          QST_CORRECT_ANSWER, QST_LEVEL, QST_TIME_LIMIT, QST_POINTS, QST_CREATED_AT)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `qst-${i}`, "MCQ", "thm-1",
      `Question numéro ${i} pour le quiz de test ?`,
      "Paris", "Lyon", "Marseille", "Toulouse",
      "Paris", 1, 30, 10, "2026-03-17T10:00:00.000Z"
    );
  }

  // Quiz
  db.prepare(
    `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT) VALUES (?, ?, ?)`
  ).run("quiz-1", "Mon quiz", "2026-03-17T10:00:00.000Z");

  // Quiz-question links
  for (let i = 1; i <= 3; i++) {
    db.prepare(
      `INSERT INTO T_QUIZ_QUESTION_QQN (QQN_QUIZ_ID, QQN_QUESTION_ID, QQN_ORDER) VALUES (?, ?, ?)`
    ).run("quiz-1", `qst-${i}`, i);
  }

  // Game
  db.prepare(
    `INSERT INTO T_GAME_GAM (GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT)
     VALUES (?, ?, 'OPEN', ?)`
  ).run("gam-1", "quiz-1", "2026-03-17T10:00:00.000Z");

  // Participants
  db.prepare(
    `INSERT INTO T_GAME_PARTICIPANT_GPA (GPA_GAME_ID, GPA_NAME, GPA_ORDER) VALUES (?, ?, ?)`
  ).run("gam-1", "Alice", 1);
  db.prepare(
    `INSERT INTO T_GAME_PARTICIPANT_GPA (GPA_GAME_ID, GPA_NAME, GPA_ORDER) VALUES (?, ?, ?)`
  ).run("gam-1", "Bob", 2);
  db.prepare(
    `INSERT INTO T_GAME_PARTICIPANT_GPA (GPA_GAME_ID, GPA_NAME, GPA_ORDER) VALUES (?, ?, ?)`
  ).run("gam-1", "Charlie", 3);

  return db;
}

const NOW = "2026-03-17T10:01:00.000Z";

describe("gameAnswerRepository", () => {
  let db;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => db.close());

  // ── insertGameAnswer ─────────────────────────────────────────────────────

  describe("insertGameAnswer", () => {
    it("inserts a single answer and can be retrieved", () => {
      insertGameAnswer(db, {
        id: "gaa-1",
        gameId: "gam-1",
        questionId: "qst-1",
        participantOrder: 1,
        answer: "A",
        timeMs: 3100,
        pointsEarned: 10,
        cumulativeScore: 10,
        createdAt: NOW,
      });

      const row = db.prepare("SELECT * FROM T_GAME_ANSWER_GAA WHERE GAA_ID = ?").get("gaa-1");
      expect(row.GAA_GAME_ID).toBe("gam-1");
      expect(row.GAA_QUESTION_ID).toBe("qst-1");
      expect(row.GAA_PARTICIPANT_ORDER).toBe(1);
      expect(row.GAA_ANSWER).toBe("A");
      expect(row.GAA_TIME_MS).toBe(3100);
      expect(row.GAA_POINTS_EARNED).toBe(10);
      expect(row.GAA_CUMULATIVE_SCORE).toBe(10);
    });

    it("allows null answer for unanswered participant (CA-33)", () => {
      insertGameAnswer(db, {
        id: "gaa-2",
        gameId: "gam-1",
        questionId: "qst-1",
        participantOrder: 2,
        answer: null,
        timeMs: 30000,
        pointsEarned: 0,
        cumulativeScore: 0,
        createdAt: NOW,
      });

      const row = db.prepare("SELECT * FROM T_GAME_ANSWER_GAA WHERE GAA_ID = ?").get("gaa-2");
      expect(row.GAA_ANSWER).toBeNull();
      expect(row.GAA_POINTS_EARNED).toBe(0);
    });

    it("throws on duplicate (game_id, question_id, participant_order)", () => {
      insertGameAnswer(db, {
        id: "gaa-1", gameId: "gam-1", questionId: "qst-1", participantOrder: 1,
        answer: "A", timeMs: 3100, pointsEarned: 10, cumulativeScore: 10, createdAt: NOW,
      });

      expect(() =>
        insertGameAnswer(db, {
          id: "gaa-dup", gameId: "gam-1", questionId: "qst-1", participantOrder: 1,
          answer: "B", timeMs: 5000, pointsEarned: 0, cumulativeScore: 10, createdAt: NOW,
        })
      ).toThrow();
    });
  });

  // ── insertGameAnswers (batch — CA-32) ─────────────────────────────────────

  describe("insertGameAnswers", () => {
    it("inserts multiple answers atomically", () => {
      const answers = [
        { id: "gaa-1", gameId: "gam-1", questionId: "qst-1", participantOrder: 1, answer: "A", timeMs: 3100, pointsEarned: 10, cumulativeScore: 10, createdAt: NOW },
        { id: "gaa-2", gameId: "gam-1", questionId: "qst-1", participantOrder: 2, answer: "C", timeMs: 5200, pointsEarned: 0, cumulativeScore: 0, createdAt: NOW },
        { id: "gaa-3", gameId: "gam-1", questionId: "qst-1", participantOrder: 3, answer: null, timeMs: 30000, pointsEarned: 0, cumulativeScore: 0, createdAt: NOW },
      ];

      insertGameAnswers(db, answers);

      const count = db.prepare("SELECT COUNT(*) AS c FROM T_GAME_ANSWER_GAA WHERE GAA_GAME_ID = ?").get("gam-1").c;
      expect(count).toBe(3);
    });

    it("rolls back all inserts if one fails (atomicity)", () => {
      const answers = [
        { id: "gaa-1", gameId: "gam-1", questionId: "qst-1", participantOrder: 1, answer: "A", timeMs: 3100, pointsEarned: 10, cumulativeScore: 10, createdAt: NOW },
        { id: "gaa-1", gameId: "gam-1", questionId: "qst-1", participantOrder: 1, answer: "B", timeMs: 5000, pointsEarned: 0, cumulativeScore: 10, createdAt: NOW }, // duplicate ID
      ];

      expect(() => insertGameAnswers(db, answers)).toThrow();

      const count = db.prepare("SELECT COUNT(*) AS c FROM T_GAME_ANSWER_GAA").get().c;
      expect(count).toBe(0);
    });
  });

  // ── findAnswersByGameAndQuestion ──────────────────────────────────────────

  describe("findAnswersByGameAndQuestion", () => {
    it("returns answers for a given game and question, sorted by participant order", () => {
      insertGameAnswers(db, [
        { id: "gaa-1", gameId: "gam-1", questionId: "qst-1", participantOrder: 2, answer: "B", timeMs: 5000, pointsEarned: 0, cumulativeScore: 0, createdAt: NOW },
        { id: "gaa-2", gameId: "gam-1", questionId: "qst-1", participantOrder: 1, answer: "A", timeMs: 3100, pointsEarned: 10, cumulativeScore: 10, createdAt: NOW },
      ]);

      const rows = findAnswersByGameAndQuestion(db, "gam-1", "qst-1");
      expect(rows).toHaveLength(2);
      expect(rows[0].GAA_PARTICIPANT_ORDER).toBe(1);
      expect(rows[1].GAA_PARTICIPANT_ORDER).toBe(2);
    });

    it("returns empty array when no answers exist", () => {
      const rows = findAnswersByGameAndQuestion(db, "gam-1", "qst-1");
      expect(rows).toEqual([]);
    });
  });

  // ── findAnswersByGame ─────────────────────────────────────────────────────

  describe("findAnswersByGame", () => {
    it("returns all answers for a game, sorted by question then participant", () => {
      insertGameAnswers(db, [
        { id: "gaa-1", gameId: "gam-1", questionId: "qst-1", participantOrder: 1, answer: "A", timeMs: 3100, pointsEarned: 10, cumulativeScore: 10, createdAt: NOW },
        { id: "gaa-2", gameId: "gam-1", questionId: "qst-2", participantOrder: 1, answer: "B", timeMs: 4000, pointsEarned: 0, cumulativeScore: 10, createdAt: NOW },
      ]);

      const rows = findAnswersByGame(db, "gam-1");
      expect(rows).toHaveLength(2);
    });

    it("returns empty array when game has no answers", () => {
      expect(findAnswersByGame(db, "gam-1")).toEqual([]);
    });
  });

  // ── getCumulativeScore ────────────────────────────────────────────────────

  describe("getCumulativeScore", () => {
    it("returns 0 when participant has no answers yet", () => {
      expect(getCumulativeScore(db, "gam-1", 1)).toBe(0);
    });

    it("returns the latest cumulative score for a participant", () => {
      insertGameAnswers(db, [
        { id: "gaa-1", gameId: "gam-1", questionId: "qst-1", participantOrder: 1, answer: "A", timeMs: 3100, pointsEarned: 10, cumulativeScore: 10, createdAt: "2026-03-17T10:01:00.000Z" },
        { id: "gaa-2", gameId: "gam-1", questionId: "qst-2", participantOrder: 1, answer: "A", timeMs: 4000, pointsEarned: 10, cumulativeScore: 20, createdAt: "2026-03-17T10:02:00.000Z" },
      ]);

      expect(getCumulativeScore(db, "gam-1", 1)).toBe(20);
    });
  });

  // ── updateGameQuestionIndex (CA-2) ────────────────────────────────────────

  describe("updateGameQuestionIndex", () => {
    it("updates GAM_CURRENT_QUESTION_INDEX for the given game", () => {
      updateGameQuestionIndex(db, "gam-1", 2);

      const row = db.prepare("SELECT GAM_CURRENT_QUESTION_INDEX FROM T_GAME_GAM WHERE GAM_ID = ?").get("gam-1");
      expect(row.GAM_CURRENT_QUESTION_INDEX).toBe(2);
    });
  });

  // ── findActiveGame ────────────────────────────────────────────────────────

  describe("findActiveGame", () => {
    it("returns the active game (not COMPLETED, not IN_ERROR)", () => {
      const game = findActiveGame(db);
      expect(game).toBeDefined();
      expect(game.GAM_ID).toBe("gam-1");
      expect(game.GAM_STATUS).toBe("OPEN");
      expect(game.GAM_CURRENT_QUESTION_INDEX).toBe(0);
    });

    it("returns undefined when no active game", () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'COMPLETED' WHERE GAM_ID = ?").run("gam-1");
      expect(findActiveGame(db)).toBeUndefined();
    });

    it("ignores IN_ERROR games", () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'IN_ERROR' WHERE GAM_ID = ?").run("gam-1");
      expect(findActiveGame(db)).toBeUndefined();
    });

    it("returns game in QUESTION_TITLE state as active", () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");
      const game = findActiveGame(db);
      expect(game).toBeDefined();
      expect(game.GAM_STATUS).toBe("QUESTION_TITLE");
    });

    it("returns game in QUESTION_OPEN state as active", () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_OPEN' WHERE GAM_ID = ?").run("gam-1");
      const game = findActiveGame(db);
      expect(game).toBeDefined();
      expect(game.GAM_STATUS).toBe("QUESTION_OPEN");
    });

    it("returns game in QUESTION_CLOSED state as active", () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_CLOSED' WHERE GAM_ID = ?").run("gam-1");
      const game = findActiveGame(db);
      expect(game).toBeDefined();
    });
  });
});