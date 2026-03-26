import { openDatabase } from "../src/database/database.js";
import {
  insertQuiz,
  insertQuizQuestions,
  findQuizById,
  findQuizByName,
  findAllQuizzes,
  getQuizQuestionIds,
  updateQuiz,
  deleteQuizQuestions,
  deleteQuiz,
  countQuizzesByQuestion,
  findQuizWithQuestionsById,
} from "../src/repositories/quizRepository.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = openDatabase(":memory:");

  // Insérer un thème et des questions de test
  db.prepare(
    `INSERT INTO T_THEME_THM (THM_ID, THM_NAME, THM_CREATED_AT) VALUES (?, ?, ?)`
  ).run("thm-1", "Science", "2026-03-13T10:00:00.000Z");

  for (let i = 1; i <= 12; i++) {
    db.prepare(
      `INSERT INTO T_QUESTION_QST
         (QST_ID, QST_TYPE, QST_THEME_ID, QST_TITLE,
          QST_CORRECT_ANSWER, QST_LEVEL, QST_TIME_LIMIT, QST_POINTS, QST_CREATED_AT)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `qst-${i}`, "SPEED", "thm-1",
      `Question numéro ${i} de test pour le quiz ?`,
      "Réponse", (i % 5) + 1, 30, 5, "2026-03-13T10:00:00.000Z"
    );
  }

  // Add MCQ questions for testing mixed types
  for (let i = 13; i <= 20; i++) {
    db.prepare(
      `INSERT INTO T_QUESTION_QST
         (QST_ID, QST_TYPE, QST_THEME_ID, QST_TITLE,
          QST_CORRECT_ANSWER, QST_LEVEL, QST_TIME_LIMIT, QST_POINTS, QST_CREATED_AT)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `qst-${i}`, "MCQ", "thm-1",
      `Question MCQ numéro ${i - 12} de test pour le quiz ?`,
      "Réponse", ((i - 13) % 5) + 1, 30, 5, "2026-03-13T10:00:00.000Z"
    );
  }

  return db;
}

const NOW = "2026-03-13T10:00:00.000Z";
const LATER = "2026-03-13T12:00:00.000Z";
const Q_IDS = Array.from({ length: 10 }, (_, i) => `qst-${i + 1}`);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("quizRepository", () => {
  let db;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => db.close());

  // ── insertQuiz ─────────────────────────────────────────────────────────────

  describe("insertQuiz", () => {
    it("inserts a quiz and can be retrieved by ID", () => {
      insertQuiz(db, { id: "quz-1", name: "Culture générale", createdAt: NOW });
      const row = db.prepare("SELECT * FROM T_QUIZ_QUZ WHERE QUZ_ID = ?").get("quz-1");
      expect(row.QUZ_NAME).toBe("Culture générale");
      expect(row.QUZ_LAST_UPDATED_AT).toBeNull();
    });

    it("throws on duplicate name (COLLATE NOCASE)", () => {
      insertQuiz(db, { id: "quz-1", name: "Sciences exactes", createdAt: NOW });
      expect(() =>
        insertQuiz(db, { id: "quz-2", name: "SCIENCES EXACTES", createdAt: NOW })
      ).toThrow();
    });
  });

  // ── insertQuizQuestions ────────────────────────────────────────────────────

  describe("insertQuizQuestions", () => {
    it("inserts questions with correct order", () => {
      insertQuiz(db, { id: "quz-1", name: "Mon quiz", createdAt: NOW });
      insertQuizQuestions(db, "quz-1", Q_IDS);

      const rows = db.prepare(
        "SELECT QQN_QUESTION_ID, QQN_ORDER FROM T_QUIZ_QUESTION_QQN WHERE QQN_QUIZ_ID = ? ORDER BY QQN_ORDER"
      ).all("quz-1");

      expect(rows).toHaveLength(10);
      expect(rows[0].QQN_QUESTION_ID).toBe("qst-1");
      expect(rows[0].QQN_ORDER).toBe(1);
      expect(rows[9].QQN_QUESTION_ID).toBe("qst-10");
      expect(rows[9].QQN_ORDER).toBe(10);
    });
  });

  // ── findQuizById ───────────────────────────────────────────────────────────

  describe("findQuizById", () => {
    it("returns the quiz row when found", () => {
      insertQuiz(db, { id: "quz-1", name: "Mon quiz", createdAt: NOW });
      const row = findQuizById(db, "quz-1");
      expect(row.QUZ_ID).toBe("quz-1");
      expect(row.QUZ_NAME).toBe("Mon quiz");
    });

    it("returns undefined when not found", () => {
      expect(findQuizById(db, "inexistant")).toBeUndefined();
    });
  });

  // ── findQuizByName ─────────────────────────────────────────────────────────

  describe("findQuizByName", () => {
    it("finds by exact name", () => {
      insertQuiz(db, { id: "quz-1", name: "Mon quiz", createdAt: NOW });
      expect(findQuizByName(db, "Mon quiz")).toBeDefined();
    });

    it("finds case-insensitively", () => {
      insertQuiz(db, { id: "quz-1", name: "Mon quiz", createdAt: NOW });
      expect(findQuizByName(db, "MON QUIZ")).toBeDefined();
    });

    it("returns undefined when not found", () => {
      expect(findQuizByName(db, "Inexistant")).toBeUndefined();
    });
  });

  // ── findAllQuizzes ─────────────────────────────────────────────────────────

  describe("findAllQuizzes", () => {
    it("returns empty array when no quizzes", () => {
      expect(findAllQuizzes(db, null)).toEqual([]);
    });

    it("returns quizzes sorted by created_at descending", () => {
      insertQuiz(db, { id: "quz-1", name: "Premier quiz", createdAt: NOW });
      insertQuiz(db, { id: "quz-2", name: "Deuxième quiz", createdAt: LATER });
      const result = findAllQuizzes(db, null);
      expect(result[0].id).toBe("quz-2"); // plus récent en premier
      expect(result[1].id).toBe("quz-1");
    });

    it("filters by name (contains, case-insensitive)", () => {
      insertQuiz(db, { id: "quz-1", name: "Culture générale", createdAt: NOW });
      insertQuiz(db, { id: "quz-2", name: "Sport et loisirs", createdAt: NOW });
      const result = findAllQuizzes(db, "culture");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("quz-1");
    });

    it("includes question_summary with total and by_level breakdown", () => {
      insertQuiz(db, { id: "quz-1", name: "Mon quiz", createdAt: NOW });
      insertQuizQuestions(db, "quz-1", Q_IDS); // qst-1..qst-10

      const result = findAllQuizzes(db, null);
      const summary = result[0].question_summary;

      expect(summary.total).toBe(10);
      expect(typeof summary.by_level).toBe("object");
      // Les niveaux 1 à 5 doivent être présents (même à 0)
      for (let lvl = 1; lvl <= 5; lvl++) {
        expect(summary.by_level).toHaveProperty(String(lvl));
        expect(summary.by_level[String(lvl)]).toHaveProperty("MCQ");
        expect(summary.by_level[String(lvl)]).toHaveProperty("SPEED");
      }
    });

    it("ensures all levels 1-5 present even without questions at those levels", () => {
      // Create a quiz with only SPEED questions from levels 1, 2, 3, 4, 5
      // qst-5 (level 1, SPEED), qst-1 (level 2, SPEED), qst-2 (level 3, SPEED), etc.
      // All questions are SPEED type, so all MCQ counts should be 0
      insertQuiz(db, { id: "quz-1", name: "Only SPEED quiz", createdAt: NOW });
      insertQuizQuestions(db, "quz-1", Q_IDS); // qst-1..qst-10, all SPEED type

      const result = findAllQuizzes(db, null);
      const summary = result[0].question_summary;

      expect(summary.total).toBe(10);
      // Tous les niveaux 1 à 5 doivent être présents avec MCQ et SPEED (même à 0)
      for (let lvl = 1; lvl <= 5; lvl++) {
        expect(summary.by_level[String(lvl)]).toBeDefined();
        expect(summary.by_level[String(lvl)].MCQ).toBeDefined();
        expect(summary.by_level[String(lvl)].SPEED).toBeDefined();
        expect(typeof summary.by_level[String(lvl)].MCQ).toBe("number");
        expect(typeof summary.by_level[String(lvl)].SPEED).toBe("number");
      }
      // All questions are SPEED type, so MCQ should be 0 for all levels
      for (let lvl = 1; lvl <= 5; lvl++) {
        expect(summary.by_level[String(lvl)].MCQ).toBe(0);
        expect(summary.by_level[String(lvl)].SPEED).toBeGreaterThanOrEqual(0);
      }
    });

    it("ensures all levels with complete MCQ and SPEED structure", () => {
      // Create a quiz with mixed MCQ and SPEED questions at specific levels
      // qst-13..qst-20 are MCQ: level 1, 2, 3, 4, 5, 1, 2, 3
      // Use 10 questions: qst-5 (level 1 SPEED), qst-1 (level 2 SPEED), qst-2 (level 3 SPEED),
      //                   qst-3 (level 4 SPEED), qst-4 (level 5 SPEED), qst-13 (level 1 MCQ),
      //                   qst-14 (level 2 MCQ), qst-15 (level 3 MCQ), qst-16 (level 4 MCQ), qst-17 (level 5 MCQ)
      const mixedIds = ["qst-5", "qst-1", "qst-2", "qst-3", "qst-4", "qst-13", "qst-14", "qst-15", "qst-16", "qst-17"];
      insertQuiz(db, { id: "quz-2", name: "Mixed MCQ/SPEED quiz", createdAt: NOW });
      insertQuizQuestions(db, "quz-2", mixedIds);

      const result = findAllQuizzes(db, null);
      const quizzes = result.filter(q => q.id === "quz-2");
      expect(quizzes).toHaveLength(1);

      const summary = quizzes[0].question_summary;
      expect(summary.total).toBe(10);

      // All levels 1-5 must be present with both MCQ and SPEED
      for (let lvl = 1; lvl <= 5; lvl++) {
        expect(summary.by_level[String(lvl)]).toBeDefined();
        expect(summary.by_level[String(lvl)].MCQ).toBe(1); // One MCQ at each level
        expect(summary.by_level[String(lvl)].SPEED).toBe(1); // One SPEED at each level
      }
    });

    it("returns last_updated_at as null when never updated", () => {
      insertQuiz(db, { id: "quz-1", name: "Mon quiz", createdAt: NOW });
      const result = findAllQuizzes(db, null);
      expect(result[0].last_updated_at).toBeNull();
    });
  });

  // ── getQuizQuestionIds ────────────────��────────────────────────────────────

  describe("getQuizQuestionIds", () => {
    it("returns question IDs in order", () => {
      insertQuiz(db, { id: "quz-1", name: "Mon quiz", createdAt: NOW });
      insertQuizQuestions(db, "quz-1", Q_IDS);
      const ids = getQuizQuestionIds(db, "quz-1");
      expect(ids).toEqual(Q_IDS);
    });

    it("returns empty array when quiz has no questions", () => {
      insertQuiz(db, { id: "quz-1", name: "Mon quiz", createdAt: NOW });
      expect(getQuizQuestionIds(db, "quz-1")).toEqual([]);
    });
  });

  // ── updateQuiz ─────────────────────────────────────────────────────────────

  describe("updateQuiz", () => {
    it("updates name and last_updated_at", () => {
      insertQuiz(db, { id: "quz-1", name: "Ancien nom", createdAt: NOW });
      updateQuiz(db, "quz-1", "Nouveau nom", LATER);
      const row = findQuizById(db, "quz-1");
      expect(row.QUZ_NAME).toBe("Nouveau nom");
      expect(row.QUZ_LAST_UPDATED_AT).toBe(LATER);
    });
  });

  // ── deleteQuizQuestions ────────────────────────────────────────────────────

  describe("deleteQuizQuestions", () => {
    it("removes all question links for a quiz", () => {
      insertQuiz(db, { id: "quz-1", name: "Mon quiz", createdAt: NOW });
      insertQuizQuestions(db, "quz-1", Q_IDS);
      deleteQuizQuestions(db, "quz-1");
      const rows = db.prepare(
        "SELECT * FROM T_QUIZ_QUESTION_QQN WHERE QQN_QUIZ_ID = ?"
      ).all("quz-1");
      expect(rows).toHaveLength(0);
    });
  });

  // ── deleteQuiz ─────────────────────────────────────────────────────────────

  describe("deleteQuiz", () => {
    it("returns 1 when quiz deleted", () => {
      insertQuiz(db, { id: "quz-1", name: "Mon quiz", createdAt: NOW });
      expect(deleteQuiz(db, "quz-1")).toBe(1);
    });

    it("returns 0 when quiz not found", () => {
      expect(deleteQuiz(db, "inexistant")).toBe(0);
    });
  });

  // ── findQuizWithQuestionsById ──────────────────────────────────────────────

  describe("findQuizWithQuestionsById", () => {
    it("returns quiz with question_ids when found", () => {
      insertQuiz(db, { id: "quz-1", name: "Mon quiz", createdAt: NOW });
      insertQuizQuestions(db, "quz-1", Q_IDS);

      const result = findQuizWithQuestionsById(db, "quz-1");

      expect(result).toBeDefined();
      expect(result.id).toBe("quz-1");
      expect(result.name).toBe("Mon quiz");
      expect(result.question_ids).toEqual(Q_IDS);
      expect(result.created_at).toBe(NOW);
      expect(result.last_updated_at).toBeNull();
    });

    it("returns undefined when quiz not found", () => {
      expect(findQuizWithQuestionsById(db, "inexistant")).toBeUndefined();
    });

    it("preserves question order", () => {
      insertQuiz(db, { id: "quz-1", name: "Mon quiz", createdAt: NOW });
      const reversed = [...Q_IDS].reverse();
      insertQuizQuestions(db, "quz-1", reversed);

      const result = findQuizWithQuestionsById(db, "quz-1");
      expect(result.question_ids).toEqual(reversed);
    });
  });

  // ── countQuizzesByQuestion ─────────────────────────────────────────────────

  describe("countQuizzesByQuestion", () => {
    it("returns 0 when question belongs to no quiz", () => {
      expect(countQuizzesByQuestion(db, "qst-1")).toBe(0);
    });

    it("returns correct count when question belongs to a quiz", () => {
      insertQuiz(db, { id: "quz-1", name: "Mon quiz", createdAt: NOW });
      insertQuizQuestions(db, "quz-1", Q_IDS);
      expect(countQuizzesByQuestion(db, "qst-1")).toBe(1);
    });
  });
});