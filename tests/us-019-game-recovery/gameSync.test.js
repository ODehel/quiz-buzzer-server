import { jest } from "@jest/globals";
import { openDatabase } from "../../src/database/database.js";
import { syncGameStateOnConnect } from "../../src/game/gameSync.js";
import logger from "../../src/config/logger.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = openDatabase(":memory:");

  db.prepare(
    `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT) VALUES (?, ?, ?)`
  ).run("quiz-1", "Mon quiz", "2026-03-27T10:00:00.000Z");

  return db;
}

function insertGame(db, { id = "gam-1", quizId = "quiz-1", status = "OPEN", questionIndex = 0 } = {}) {
  db.prepare(
    `INSERT INTO T_GAME_GAM (GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CURRENT_QUESTION_INDEX, GAM_CREATED_AT)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, quizId, status, questionIndex, "2026-03-27T10:00:00.000Z");
}

function insertParticipants(db, gameId = "gam-1", names = ["Alice", "Bob", "Charlie"]) {
  names.forEach((name, i) => {
    db.prepare(
      `INSERT INTO T_GAME_PARTICIPANT_GPA (GPA_GAME_ID, GPA_NAME, GPA_ORDER) VALUES (?, ?, ?)`
    ).run(gameId, name, i + 1);
  });
}

function insertThemeAndQuestion(db) {
  db.prepare(
    `INSERT OR IGNORE INTO T_THEME_THM (THM_ID, THM_NAME, THM_CREATED_AT) VALUES (?, ?, ?)`
  ).run("thm-1", "Science", "2026-03-27T10:00:00.000Z");

  db.prepare(
    `INSERT OR IGNORE INTO T_QUESTION_QST
       (QST_ID, QST_TYPE, QST_THEME_ID, QST_TITLE,
        QST_CHOICE_A, QST_CHOICE_B, QST_CHOICE_C, QST_CHOICE_D,
        QST_CORRECT_ANSWER, QST_LEVEL, QST_TIME_LIMIT, QST_POINTS, QST_CREATED_AT)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("qst-1", "MCQ", "thm-1", "Question 1?", "A", "B", "C", "D", "A", 1, 30, 10, "2026-03-27T10:00:00.000Z");
}

function insertAnswer(db, { gameId = "gam-1", questionId = "qst-1", participantOrder, pointsEarned, cumulativeScore }) {
  insertThemeAndQuestion(db);
  db.prepare(
    `INSERT INTO T_GAME_ANSWER_GAA
       (GAA_ID, GAA_GAME_ID, GAA_QUESTION_ID, GAA_PARTICIPANT_ORDER,
        GAA_ANSWER, GAA_TIME_MS, GAA_POINTS_EARNED, GAA_CUMULATIVE_SCORE, GAA_CREATED_AT)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `gaa-${gameId}-${questionId}-${participantOrder}`,
    gameId, questionId, participantOrder,
    "A", 5000, pointsEarned, cumulativeScore, "2026-03-27T10:00:00.000Z"
  );
}

function createMockSend() {
  const messages = [];
  return { messages, fn: (msg) => messages.push(msg) };
}

// ─── Spy on logger ───────────────────────────────────────────────────────────

let logInfoSpy;

beforeEach(() => {
  logInfoSpy = jest.spyOn(logger, "info").mockImplementation(() => {});
});

afterEach(() => {
  logInfoSpy.mockRestore();
});

// ─── Admin sync tests (CA-10 to CA-15) ──────────────────────────────────────

describe("syncGameStateOnConnect — admin (game_state_sync)", () => {
  // CA-10: Pas de partie active → rien envoyé
  test("CA-10: no active game — no message sent", () => {
    const db = createTestDb();
    const mock = createMockSend();

    syncGameStateOnConnect(null, "admin", "admin_user", db, { sendFn: mock.fn });

    expect(mock.messages).toHaveLength(0);
  });

  // CA-10: Partie en PENDING → pas de sync
  test("CA-10: game in PENDING — no message sent", () => {
    const db = createTestDb();
    insertGame(db, { status: "PENDING" });
    const mock = createMockSend();

    syncGameStateOnConnect(null, "admin", "admin_user", db, { sendFn: mock.fn });

    expect(mock.messages).toHaveLength(0);
  });

  // CA-11: Partie en OPEN → game_state_sync sans started_at/time_limit
  test("CA-11: game in OPEN — sends game_state_sync without timer fields", () => {
    const db = createTestDb();
    insertGame(db, { status: "OPEN", questionIndex: 2 });
    insertParticipants(db);
    insertAnswer(db, { participantOrder: 1, pointsEarned: 10, cumulativeScore: 30 });
    insertAnswer(db, { participantOrder: 2, pointsEarned: 5, cumulativeScore: 15 });
    const mock = createMockSend();

    syncGameStateOnConnect(null, "admin", "admin_user", db, { sendFn: mock.fn });

    expect(mock.messages).toHaveLength(1);
    const msg = mock.messages[0];
    expect(msg.type).toBe("game_state_sync");
    expect(msg.game_id).toBe("gam-1");
    expect(msg.status).toBe("OPEN");
    expect(msg.question_index).toBe(2);
    expect(msg.quiz_id).toBe("quiz-1");
    expect(msg.started_at).toBeUndefined();
    expect(msg.time_limit).toBeUndefined();
    // CA-14: participants with scores
    expect(msg.participants).toHaveLength(3);
    expect(msg.participants[0]).toEqual({ order: 1, name: "Alice", cumulative_score: 30 });
    expect(msg.participants[1]).toEqual({ order: 2, name: "Bob", cumulative_score: 15 });
    expect(msg.participants[2]).toEqual({ order: 3, name: "Charlie", cumulative_score: 0 });
  });

  // CA-12: QUESTION_TITLE → game_state_sync sans started_at/time_limit
  test("CA-12: game in QUESTION_TITLE — sends game_state_sync without timer fields", () => {
    const db = createTestDb();
    insertGame(db, { status: "QUESTION_TITLE", questionIndex: 1 });
    insertParticipants(db);
    const mock = createMockSend();

    syncGameStateOnConnect(null, "admin", "admin_user", db, { sendFn: mock.fn });

    const msg = mock.messages[0];
    expect(msg.type).toBe("game_state_sync");
    expect(msg.status).toBe("QUESTION_TITLE");
    expect(msg.started_at).toBeUndefined();
    expect(msg.time_limit).toBeUndefined();
  });

  // CA-12: QUESTION_CLOSED → game_state_sync sans started_at/time_limit
  test("CA-12: game in QUESTION_CLOSED — sends game_state_sync without timer fields", () => {
    const db = createTestDb();
    insertGame(db, { status: "QUESTION_CLOSED", questionIndex: 3 });
    insertParticipants(db);
    const mock = createMockSend();

    syncGameStateOnConnect(null, "admin", "admin_user", db, { sendFn: mock.fn });

    const msg = mock.messages[0];
    expect(msg.type).toBe("game_state_sync");
    expect(msg.status).toBe("QUESTION_CLOSED");
    expect(msg.started_at).toBeUndefined();
    expect(msg.time_limit).toBeUndefined();
  });

  // CA-13: QUESTION_OPEN → game_state_sync avec started_at et time_limit
  test("CA-13: game in QUESTION_OPEN — sends game_state_sync with timer fields", () => {
    const db = createTestDb();
    insertGame(db, { status: "QUESTION_OPEN", questionIndex: 2 });
    insertParticipants(db);
    const mock = createMockSend();
    const timerInfo = { startedAt: "2026-03-27T14:30:00.000Z", timeLimit: 30 };

    syncGameStateOnConnect(null, "admin", "admin_user", db, {
      sendFn: mock.fn,
      getTimerInfo: () => timerInfo,
    });

    const msg = mock.messages[0];
    expect(msg.type).toBe("game_state_sync");
    expect(msg.started_at).toBe("2026-03-27T14:30:00.000Z");
    expect(msg.time_limit).toBe(30);
  });

  // CA-13: QUESTION_BUZZED → game_state_sync avec started_at et time_limit
  test("CA-13: game in QUESTION_BUZZED — sends game_state_sync with timer fields", () => {
    const db = createTestDb();
    insertGame(db, { status: "QUESTION_BUZZED", questionIndex: 1 });
    insertParticipants(db);
    const mock = createMockSend();
    const timerInfo = { startedAt: "2026-03-27T14:30:00.000Z", timeLimit: 15 };

    syncGameStateOnConnect(null, "admin", "admin_user", db, {
      sendFn: mock.fn,
      getTimerInfo: () => timerInfo,
    });

    const msg = mock.messages[0];
    expect(msg.started_at).toBe("2026-03-27T14:30:00.000Z");
    expect(msg.time_limit).toBe(15);
  });

  // CA-13: QUESTION_OPEN but no timer info available
  test("CA-13: QUESTION_OPEN but no timer info — sends game_state_sync without timer fields", () => {
    const db = createTestDb();
    insertGame(db, { status: "QUESTION_OPEN", questionIndex: 2 });
    insertParticipants(db);
    const mock = createMockSend();

    syncGameStateOnConnect(null, "admin", "admin_user", db, {
      sendFn: mock.fn,
      getTimerInfo: () => null,
    });

    const msg = mock.messages[0];
    expect(msg.started_at).toBeUndefined();
    expect(msg.time_limit).toBeUndefined();
  });

  // CA-14: Vérifier la structure complète des participants
  test("CA-14: game_state_sync contains game_id, status, question_index, quiz_id, participants", () => {
    const db = createTestDb();
    insertGame(db, { status: "OPEN", questionIndex: 0 });
    insertParticipants(db);
    const mock = createMockSend();

    syncGameStateOnConnect(null, "admin", "admin_user", db, { sendFn: mock.fn });

    const msg = mock.messages[0];
    expect(msg).toHaveProperty("game_id");
    expect(msg).toHaveProperty("status");
    expect(msg).toHaveProperty("question_index");
    expect(msg).toHaveProperty("quiz_id");
    expect(msg).toHaveProperty("participants");
    expect(Array.isArray(msg.participants)).toBe(true);
    msg.participants.forEach((p) => {
      expect(p).toHaveProperty("order");
      expect(p).toHaveProperty("name");
      expect(p).toHaveProperty("cumulative_score");
    });
  });

  // CA-15: IN_ERROR → pas de game_state_sync
  test("CA-15: game in IN_ERROR — no message sent", () => {
    const db = createTestDb();
    insertGame(db, { status: "IN_ERROR" });
    const mock = createMockSend();

    syncGameStateOnConnect(null, "admin", "admin_user", db, { sendFn: mock.fn });

    expect(mock.messages).toHaveLength(0);
  });

  // CA-15: COMPLETED → pas de game_state_sync
  test("CA-15: game in COMPLETED — no message sent", () => {
    const db = createTestDb();
    insertGame(db, { status: "COMPLETED" });
    const mock = createMockSend();

    syncGameStateOnConnect(null, "admin", "admin_user", db, { sendFn: mock.fn });

    expect(mock.messages).toHaveLength(0);
  });

  // CA-24: Log GAME_STATE_SYNC_SENT
  test("CA-24: logs GAME_STATE_SYNC_SENT with game_id and status", () => {
    const db = createTestDb();
    insertGame(db, { status: "OPEN", questionIndex: 1 });
    insertParticipants(db);
    const mock = createMockSend();

    syncGameStateOnConnect(null, "admin", "admin_user", db, { sendFn: mock.fn });

    const logCall = logInfoSpy.mock.calls.find((c) => c[0]?.event === "GAME_STATE_SYNC_SENT");
    expect(logCall).toBeDefined();
    expect(logCall[0]).toEqual(expect.objectContaining({
      event: "GAME_STATE_SYNC_SENT",
      game_id: "gam-1",
      status: "OPEN",
    }));
  });
});

// ─── Buzzer sync tests (CA-16 to CA-20) ────────────────────────────────────

describe("syncGameStateOnConnect — buzzer (game_resumed)", () => {
  // CA-16: Pas de partie active → rien envoyé
  test("CA-16: no active game — no message sent", () => {
    const db = createTestDb();
    const mock = createMockSend();

    syncGameStateOnConnect(null, "buzzer", "Alice", db, { sendFn: mock.fn });

    expect(mock.messages).toHaveLength(0);
  });

  // CA-17: Partie active → game_resumed envoyé
  test("CA-17: active game exists — sends game_resumed", () => {
    const db = createTestDb();
    insertGame(db, { status: "OPEN", questionIndex: 2 });
    insertParticipants(db);
    insertAnswer(db, { participantOrder: 1, pointsEarned: 10, cumulativeScore: 30 });
    const mock = createMockSend();

    syncGameStateOnConnect(null, "buzzer", "Alice", db, { sendFn: mock.fn });

    expect(mock.messages).toHaveLength(1);
    const msg = mock.messages[0];
    expect(msg.type).toBe("game_resumed");
    expect(msg.question_index).toBe(2);
    expect(msg.cumulative_score).toBe(30);
    expect(msg.status).toBe("OPEN");
  });

  // CA-17: Partie en QUESTION_TITLE → game_resumed envoyé
  test("CA-17: game in QUESTION_TITLE — sends game_resumed", () => {
    const db = createTestDb();
    insertGame(db, { status: "QUESTION_TITLE", questionIndex: 1 });
    insertParticipants(db);
    const mock = createMockSend();

    syncGameStateOnConnect(null, "buzzer", "Bob", db, { sendFn: mock.fn });

    const msg = mock.messages[0];
    expect(msg.type).toBe("game_resumed");
    expect(msg.status).toBe("QUESTION_TITLE");
  });

  // CA-18: game_resumed contient question_index, cumulative_score, status
  test("CA-18: game_resumed contains required fields", () => {
    const db = createTestDb();
    insertGame(db, { status: "QUESTION_OPEN", questionIndex: 3 });
    insertParticipants(db);
    insertAnswer(db, { participantOrder: 2, pointsEarned: 10, cumulativeScore: 15 });
    const mock = createMockSend();

    syncGameStateOnConnect(null, "buzzer", "Bob", db, { sendFn: mock.fn });

    const msg = mock.messages[0];
    expect(msg).toHaveProperty("question_index", 3);
    expect(msg).toHaveProperty("cumulative_score", 15);
    expect(msg).toHaveProperty("status", "QUESTION_OPEN");
  });

  // CA-18: Chaque buzzer ne reçoit que son propre score
  test("CA-18: each buzzer only receives its own cumulative score", () => {
    const db = createTestDb();
    insertGame(db, { status: "OPEN", questionIndex: 2 });
    insertParticipants(db);
    insertAnswer(db, { participantOrder: 1, pointsEarned: 10, cumulativeScore: 30 });
    insertAnswer(db, { participantOrder: 2, pointsEarned: 5, cumulativeScore: 15 });

    // Alice (order 1) should see 30
    const mockAlice = createMockSend();
    syncGameStateOnConnect(null, "buzzer", "Alice", db, { sendFn: mockAlice.fn });
    expect(mockAlice.messages[0].cumulative_score).toBe(30);

    // Bob (order 2) should see 15
    const mockBob = createMockSend();
    syncGameStateOnConnect(null, "buzzer", "Bob", db, { sendFn: mockBob.fn });
    expect(mockBob.messages[0].cumulative_score).toBe(15);
  });

  // CA-19: Buzzer sans point → cumulative_score: 0
  test("CA-19: buzzer with no points — cumulative_score is 0", () => {
    const db = createTestDb();
    insertGame(db, { status: "OPEN", questionIndex: 1 });
    insertParticipants(db);
    const mock = createMockSend();

    syncGameStateOnConnect(null, "buzzer", "Charlie", db, { sendFn: mock.fn });

    expect(mock.messages[0].cumulative_score).toBe(0);
  });

  // CA-20: IN_ERROR → pas de game_resumed
  test("CA-20: game in IN_ERROR — no message sent", () => {
    const db = createTestDb();
    insertGame(db, { status: "IN_ERROR" });
    const mock = createMockSend();

    syncGameStateOnConnect(null, "buzzer", "Alice", db, { sendFn: mock.fn });

    expect(mock.messages).toHaveLength(0);
  });

  // CA-20: PENDING → pas de game_resumed
  test("CA-20: game in PENDING — no message sent", () => {
    const db = createTestDb();
    insertGame(db, { status: "PENDING" });
    const mock = createMockSend();

    syncGameStateOnConnect(null, "buzzer", "Alice", db, { sendFn: mock.fn });

    expect(mock.messages).toHaveLength(0);
  });

  // CA-20: COMPLETED → pas de game_resumed
  test("CA-20: game in COMPLETED — no message sent", () => {
    const db = createTestDb();
    insertGame(db, { status: "COMPLETED" });
    const mock = createMockSend();

    syncGameStateOnConnect(null, "buzzer", "Alice", db, { sendFn: mock.fn });

    expect(mock.messages).toHaveLength(0);
  });

  // CA-25: Log GAME_RESUMED_SENT
  test("CA-25: logs GAME_RESUMED_SENT with game_id and username", () => {
    const db = createTestDb();
    insertGame(db, { status: "OPEN", questionIndex: 0 });
    insertParticipants(db);
    const mock = createMockSend();

    syncGameStateOnConnect(null, "buzzer", "Alice", db, { sendFn: mock.fn });

    const logCall = logInfoSpy.mock.calls.find((c) => c[0]?.event === "GAME_RESUMED_SENT");
    expect(logCall).toBeDefined();
    expect(logCall[0]).toEqual(expect.objectContaining({
      event: "GAME_RESUMED_SENT",
      game_id: "gam-1",
      username: "Alice",
    }));
  });

  // Buzzer not a participant — still gets game_resumed with score 0
  test("buzzer not a participant — sends game_resumed with cumulative_score 0", () => {
    const db = createTestDb();
    insertGame(db, { status: "OPEN", questionIndex: 1 });
    insertParticipants(db);
    const mock = createMockSend();

    syncGameStateOnConnect(null, "buzzer", "UnknownPlayer", db, { sendFn: mock.fn });

    expect(mock.messages).toHaveLength(1);
    expect(mock.messages[0].cumulative_score).toBe(0);
  });

  // Case-insensitive username matching
  test("username matching is case-insensitive", () => {
    const db = createTestDb();
    insertGame(db, { status: "OPEN", questionIndex: 0 });
    insertParticipants(db);
    insertAnswer(db, { participantOrder: 1, pointsEarned: 10, cumulativeScore: 30 });
    const mock = createMockSend();

    syncGameStateOnConnect(null, "buzzer", "alice", db, { sendFn: mock.fn });

    expect(mock.messages[0].cumulative_score).toBe(30);
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe("syncGameStateOnConnect — edge cases", () => {
  // Unknown role — no message
  test("unknown role — no message sent", () => {
    const db = createTestDb();
    insertGame(db, { status: "OPEN" });
    insertParticipants(db);
    const mock = createMockSend();

    syncGameStateOnConnect(null, "unknown_role", "user", db, { sendFn: mock.fn });

    expect(mock.messages).toHaveLength(0);
  });
});
