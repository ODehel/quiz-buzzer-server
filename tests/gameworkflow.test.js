import { openDatabase } from "../src/database/database.js";
import {
  transitionState,
  ALLOWED_TRANSITIONS,
  resolveCurrentQuestion,
  hasMoreQuestions,
} from "../src/game/gameWorkflow.js";
import { updateGameStatus } from "../src/repositories/gameRepository.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = openDatabase(":memory:");

  db.prepare(
    `INSERT INTO T_THEME_THM (THM_ID, THM_NAME, THM_CREATED_AT) VALUES (?, ?, ?)`
  ).run("thm-1", "Science", "2026-03-17T10:00:00.000Z");

  for (let i = 1; i <= 12; i++) {
    db.prepare(
      `INSERT INTO T_QUESTION_QST
         (QST_ID, QST_TYPE, QST_THEME_ID, QST_TITLE,
          QST_CHOICE_A, QST_CHOICE_B, QST_CHOICE_C, QST_CHOICE_D,
          QST_CORRECT_ANSWER, QST_LEVEL, QST_TIME_LIMIT, QST_POINTS, QST_CREATED_AT)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `qst-${i}`, "MCQ", "thm-1",
      `Question numéro ${String(i).padStart(2, "0")} pour le quiz de test ?`,
      "Paris", "Lyon", "Marseille", "Toulouse",
      "Paris", (i % 5) + 1, 30, 10, "2026-03-17T10:00:00.000Z"
    );
  }

  db.prepare(
    `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT) VALUES (?, ?, ?)`
  ).run("quiz-1", "Mon quiz", "2026-03-17T10:00:00.000Z");

  for (let i = 1; i <= 12; i++) {
    db.prepare(
      `INSERT INTO T_QUIZ_QUESTION_QQN (QQN_QUIZ_ID, QQN_QUESTION_ID, QQN_ORDER) VALUES (?, ?, ?)`
    ).run("quiz-1", `qst-${i}`, i);
  }

  db.prepare(
    `INSERT INTO T_GAME_GAM (GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CURRENT_QUESTION_INDEX, GAM_CREATED_AT)
     VALUES (?, ?, 'OPEN', 0, ?)`
  ).run("gam-1", "quiz-1", "2026-03-17T10:00:00.000Z");

  db.prepare(
    `INSERT INTO T_GAME_PARTICIPANT_GPA (GPA_GAME_ID, GPA_NAME, GPA_ORDER) VALUES (?, ?, ?)`
  ).run("gam-1", "Alice", 1);
  db.prepare(
    `INSERT INTO T_GAME_PARTICIPANT_GPA (GPA_GAME_ID, GPA_NAME, GPA_ORDER) VALUES (?, ?, ?)`
  ).run("gam-1", "Bob", 2);

  return db;
}

function getGameStatus(db, gameId) {
  return db.prepare("SELECT GAM_STATUS, GAM_CURRENT_QUESTION_INDEX FROM T_GAME_GAM WHERE GAM_ID = ?").get(gameId);
}

// ─── ALLOWED_TRANSITIONS map (CA-1, CA-3) ─────────────────────────────────────

describe("ALLOWED_TRANSITIONS", () => {
  it("CA-1: defines the complete state machine transitions", () => {
    expect(ALLOWED_TRANSITIONS.OPEN).toContain("QUESTION_TITLE");
    expect(ALLOWED_TRANSITIONS.QUESTION_TITLE).toContain("QUESTION_OPEN");
    expect(ALLOWED_TRANSITIONS.QUESTION_OPEN).toContain("QUESTION_CLOSED");
    expect(ALLOWED_TRANSITIONS.QUESTION_CLOSED).toContain("OPEN");
    expect(ALLOWED_TRANSITIONS.QUESTION_CLOSED).toContain("COMPLETED");
  });

  it("CA-1: allows any state to transition to IN_ERROR", () => {
    const statesWithInError = ["PENDING", "OPEN", "QUESTION_TITLE", "QUESTION_OPEN", "QUESTION_CLOSED"];
    for (const state of statesWithInError) {
      expect(ALLOWED_TRANSITIONS[state]).toContain("IN_ERROR");
    }
  });

  it("CA-3: COMPLETED has no transitions (terminal state)", () => {
    expect(ALLOWED_TRANSITIONS.COMPLETED).toEqual([]);
  });

  it("CA-3: IN_ERROR has no transitions (terminal state)", () => {
    expect(ALLOWED_TRANSITIONS.IN_ERROR).toEqual([]);
  });

  it("CA-3: PENDING can only go to OPEN or IN_ERROR", () => {
    expect(ALLOWED_TRANSITIONS.PENDING).toEqual(["OPEN", "IN_ERROR"]);
  });
});

// ─── transitionState (CA-1, CA-2, CA-3) ───────────────────────────────────────

describe("transitionState", () => {
  let db;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => db.close());

  it("CA-1: OPEN → QUESTION_TITLE transitions and persists", () => {
    transitionState(db, "gam-1", "OPEN", "QUESTION_TITLE");
    const row = getGameStatus(db, "gam-1");
    expect(row.GAM_STATUS).toBe("QUESTION_TITLE");
  });

  it("CA-1: QUESTION_TITLE → QUESTION_OPEN transitions and persists", () => {
    updateGameStatus(db, "gam-1", "QUESTION_TITLE");
    transitionState(db, "gam-1", "QUESTION_TITLE", "QUESTION_OPEN");
    const row = getGameStatus(db, "gam-1");
    expect(row.GAM_STATUS).toBe("QUESTION_OPEN");
  });

  it("CA-1: QUESTION_OPEN → QUESTION_CLOSED transitions and persists", () => {
    updateGameStatus(db, "gam-1", "QUESTION_OPEN");
    transitionState(db, "gam-1", "QUESTION_OPEN", "QUESTION_CLOSED");
    const row = getGameStatus(db, "gam-1");
    expect(row.GAM_STATUS).toBe("QUESTION_CLOSED");
  });

  it("CA-1: QUESTION_CLOSED → OPEN transitions (next question)", () => {
    updateGameStatus(db, "gam-1", "QUESTION_CLOSED");
    transitionState(db, "gam-1", "QUESTION_CLOSED", "OPEN");
    const row = getGameStatus(db, "gam-1");
    expect(row.GAM_STATUS).toBe("OPEN");
  });

  it("CA-1: QUESTION_CLOSED → COMPLETED transitions (last question)", () => {
    updateGameStatus(db, "gam-1", "QUESTION_CLOSED");
    transitionState(db, "gam-1", "QUESTION_CLOSED", "COMPLETED");
    const row = getGameStatus(db, "gam-1");
    expect(row.GAM_STATUS).toBe("COMPLETED");
  });

  it("CA-1: any state → IN_ERROR transitions", () => {
    transitionState(db, "gam-1", "OPEN", "IN_ERROR");
    const row = getGameStatus(db, "gam-1");
    expect(row.GAM_STATUS).toBe("IN_ERROR");
  });

  it("CA-3: throws INVALID_TRANSITION for backward transition QUESTION_TITLE → OPEN", () => {
    updateGameStatus(db, "gam-1", "QUESTION_TITLE");
    expect(() => transitionState(db, "gam-1", "QUESTION_TITLE", "OPEN"))
      .toThrow("INVALID_TRANSITION");
  });

  it("CA-3: throws INVALID_TRANSITION for COMPLETED → anything", () => {
    updateGameStatus(db, "gam-1", "COMPLETED");
    expect(() => transitionState(db, "gam-1", "COMPLETED", "OPEN"))
      .toThrow("INVALID_TRANSITION");
  });

  it("CA-3: throws INVALID_TRANSITION for IN_ERROR → anything", () => {
    updateGameStatus(db, "gam-1", "IN_ERROR");
    expect(() => transitionState(db, "gam-1", "IN_ERROR", "OPEN"))
      .toThrow("INVALID_TRANSITION");
  });

  it("CA-3: throws INVALID_TRANSITION for OPEN → COMPLETED (skipping states)", () => {
    expect(() => transitionState(db, "gam-1", "OPEN", "COMPLETED"))
      .toThrow("INVALID_TRANSITION");
  });

  it("CA-3: throws INVALID_TRANSITION for OPEN → QUESTION_OPEN (skipping QUESTION_TITLE)", () => {
    expect(() => transitionState(db, "gam-1", "OPEN", "QUESTION_OPEN"))
      .toThrow("INVALID_TRANSITION");
  });

  it("CA-3: throws INVALID_TRANSITION for QUESTION_OPEN → OPEN (skipping QUESTION_CLOSED)", () => {
    updateGameStatus(db, "gam-1", "QUESTION_OPEN");
    expect(() => transitionState(db, "gam-1", "QUESTION_OPEN", "OPEN"))
      .toThrow("INVALID_TRANSITION");
  });

  it("CA-2: transition updates GAM_STATUS in database", () => {
    transitionState(db, "gam-1", "OPEN", "QUESTION_TITLE");
    const actual = db.prepare("SELECT GAM_STATUS FROM T_GAME_GAM WHERE GAM_ID = ?").get("gam-1");
    expect(actual.GAM_STATUS).toBe("QUESTION_TITLE");
  });

  it("throws when currentStatus does not match DB state", () => {
    // DB is OPEN, but we claim it's QUESTION_TITLE
    expect(() => transitionState(db, "gam-1", "QUESTION_TITLE", "QUESTION_OPEN"))
      .toThrow("STATE_MISMATCH");
  });

  it("throws when game does not exist", () => {
    expect(() => transitionState(db, "nonexistent", "OPEN", "QUESTION_TITLE"))
      .toThrow("GAME_NOT_FOUND");
  });
});

// ─── resolveCurrentQuestion (CA-5, CA-7) ──────────────────────────────────────

describe("resolveCurrentQuestion", () => {
  let db;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => db.close());

  it("CA-5: returns the question at the current index with all required fields", () => {
    const question = resolveCurrentQuestion(db, "quiz-1", 0);
    expect(question).toBeDefined();
    expect(question.QST_ID).toBe("qst-1");
    expect(question.QST_TYPE).toBe("MCQ");
    expect(question.QST_TITLE).toBeDefined();
    expect(question.QST_TIME_LIMIT).toBe(30);
    expect(question.QST_CHOICE_A).toBe("Paris");
    expect(question.QST_CHOICE_B).toBe("Lyon");
    expect(question.QST_CHOICE_C).toBe("Marseille");
    expect(question.QST_CHOICE_D).toBe("Toulouse");
    expect(question.QST_CORRECT_ANSWER).toBe("Paris");
    expect(question.QST_POINTS).toBe(10);
  });

  it("returns question at arbitrary index", () => {
    const question = resolveCurrentQuestion(db, "quiz-1", 4);
    expect(question.QST_ID).toBe("qst-5");
  });

  it("CA-7: returns undefined when index is out of bounds", () => {
    const question = resolveCurrentQuestion(db, "quiz-1", 99);
    expect(question).toBeUndefined();
  });

  it("returns undefined for negative index", () => {
    const question = resolveCurrentQuestion(db, "quiz-1", -1);
    expect(question).toBeUndefined();
  });
});

// ─── hasMoreQuestions (CA-29, CA-30) ──────────────────────────────────────────

describe("hasMoreQuestions", () => {
  let db;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => db.close());

  it("CA-29: returns true when there are more questions", () => {
    expect(hasMoreQuestions(db, "quiz-1", 0)).toBe(true);
    expect(hasMoreQuestions(db, "quiz-1", 5)).toBe(true);
    expect(hasMoreQuestions(db, "quiz-1", 10)).toBe(true);
  });

  it("CA-30: returns false when at the last question", () => {
    // Quiz has 12 questions (index 0-11), so index 11 is the last
    expect(hasMoreQuestions(db, "quiz-1", 11)).toBe(false);
  });

  it("returns false when index is beyond total", () => {
    expect(hasMoreQuestions(db, "quiz-1", 99)).toBe(false);
  });
});