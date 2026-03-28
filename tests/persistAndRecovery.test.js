import { jest } from "@jest/globals";
import { openDatabase } from "../src/database/database.js";
import { createGameOrchestrator } from "../src/game/gameOrchestrator.js";
import { persistWithRetry } from "../src/game/persistWithRetry.js";
import { recoverInterruptedGame } from "../src/game/gameRecovery.js";

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
      `Question numéro ${String(i).padStart(2, "0")} pour le quiz ?`,
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

  for (let i = 1; i <= 3; i++) {
    db.prepare(
      `INSERT INTO T_GAME_PARTICIPANT_GPA (GPA_GAME_ID, GPA_NAME, GPA_ORDER) VALUES (?, ?, ?)`
    ).run("gam-1", ["Alice", "Bob", "Charlie"][i - 1], i);
  }

  return db;
}

function createMockSend() {
  const messages = [];
  return {
    messages,
    broadcast: (msg) => messages.push({ target: "broadcast", ...msg }),
    sendToAdmin: (msg) => messages.push({ target: "admin", ...msg }),
    sendToBuzzer: (order, msg) => messages.push({ target: `buzzer-${order}`, ...msg }),
  };
}

function getGameRow(db) {
  return db.prepare("SELECT * FROM T_GAME_GAM WHERE GAM_ID = ?").get("gam-1");
}

// ─── persistWithRetry (CA-34) — uses real timers with very short delays ───────

describe("persistWithRetry", () => {
  it("CA-34: succeeds on first attempt when no error", async () => {
    let callCount = 0;
    await persistWithRetry(() => { callCount++; }, { baseDelayMs: 1 });
    expect(callCount).toBe(1);
  });

  it("CA-34: retries up to 3 times on failure then rejects", async () => {
    let callCount = 0;
    await expect(
      persistWithRetry(
        () => { callCount++; throw new Error("SQLITE_BUSY"); },
        { maxRetries: 3, baseDelayMs: 1 }
      )
    ).rejects.toThrow("SQLITE_BUSY");
    expect(callCount).toBe(3);
  });

  it("CA-34: succeeds on second attempt after first failure", async () => {
    let callCount = 0;
    await persistWithRetry(
      () => { callCount++; if (callCount === 1) throw new Error("SQLITE_BUSY"); },
      { baseDelayMs: 1 }
    );
    expect(callCount).toBe(2);
  });

  it("CA-34: succeeds on third attempt", async () => {
    let callCount = 0;
    await persistWithRetry(
      () => { callCount++; if (callCount < 3) throw new Error("SQLITE_BUSY"); },
      { maxRetries: 3, baseDelayMs: 1 }
    );
    expect(callCount).toBe(3);
  });
});

// ─── CA-35: orchestrator IN_ERROR on persist failure ──────────────────────────

describe("gameOrchestrator — CA-35 IN_ERROR on persist failure", () => {
  let db;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("CA-35: transitions to IN_ERROR and sends error to admin", async () => {
    const mock = createMockSend();
    const failingPersist = () => { throw new Error("SQLITE_BUSY"); };
    const orch = createGameOrchestrator(db, mock, {
      persistFn: failingPersist,
      retryOptions: { maxRetries: 3, baseDelayMs: 1 },
    });

    db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");
    orch.handleTriggerChoices();
    orch.handleAnswer(1, "A", 3100);
    orch.handleAnswer(2, "C", 5200);
    orch.handleAnswer(3, "A", 4000);

    const result = await orch.handleTriggerCorrection();

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INTERNAL_ERROR");
    expect(getGameRow(db).GAM_STATUS).toBe("IN_ERROR");

    const errorMsg = mock.messages.find((m) => m.type === "error" && m.target === "admin");
    expect(errorMsg).toBeDefined();
    expect(errorMsg.code).toBe("INTERNAL_ERROR");
  });
});

// ─── CA-36: crash recovery (US-019 — now uses recoverInterruptedGame) ────────

describe("gameOrchestrator — CA-36 crash recovery", () => {
  let db;
  let logSpy;

  beforeEach(() => {
    db = createTestDb();
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    db.close();
    logSpy.mockRestore();
  });

  it("CA-36: game in QUESTION_TITLE after crash → resets to OPEN", () => {
    db.prepare(
      "UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE', GAM_CURRENT_QUESTION_INDEX = 2 WHERE GAM_ID = ?"
    ).run("gam-1");

    recoverInterruptedGame(db);

    expect(getGameRow(db).GAM_STATUS).toBe("OPEN");
    expect(getGameRow(db).GAM_CURRENT_QUESTION_INDEX).toBe(2);
  });

  it("CA-36: game in QUESTION_OPEN after crash → resets to OPEN at same index", () => {
    db.prepare(
      "UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_OPEN', GAM_CURRENT_QUESTION_INDEX = 3 WHERE GAM_ID = ?"
    ).run("gam-1");

    recoverInterruptedGame(db);

    expect(getGameRow(db).GAM_STATUS).toBe("OPEN");
    expect(getGameRow(db).GAM_CURRENT_QUESTION_INDEX).toBe(3);
  });

  it("CA-36: game in OPEN state → no recovery needed", () => {
    recoverInterruptedGame(db);
    expect(getGameRow(db).GAM_STATUS).toBe("OPEN");
  });

  it("CA-36: game in QUESTION_CLOSED → recovers to OPEN, index + 1", () => {
    db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_CLOSED', GAM_CURRENT_QUESTION_INDEX = 2 WHERE GAM_ID = ?").run("gam-1");
    recoverInterruptedGame(db);
    expect(getGameRow(db).GAM_STATUS).toBe("OPEN");
    expect(getGameRow(db).GAM_CURRENT_QUESTION_INDEX).toBe(3);
  });

  it("CA-36: no active game → no recovery needed", () => {
    db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'COMPLETED' WHERE GAM_ID = ?").run("gam-1");
    recoverInterruptedGame(db);
    expect(getGameRow(db).GAM_STATUS).toBe("COMPLETED");
  });

  it("CA-36: after recovery, normal workflow resumes", () => {
    db.prepare(
      "UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_OPEN', GAM_CURRENT_QUESTION_INDEX = 0 WHERE GAM_ID = ?"
    ).run("gam-1");

    recoverInterruptedGame(db);

    const mock = createMockSend();
    const orch = createGameOrchestrator(db, mock);

    expect(orch.handleTriggerTitle().ok).toBe(true);
    expect(getGameRow(db).GAM_STATUS).toBe("QUESTION_TITLE");
  });
});