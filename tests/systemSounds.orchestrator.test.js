import { jest } from "@jest/globals";
import { openDatabase } from "../src/database/database.js";
import { createGameOrchestrator } from "../src/game/gameOrchestrator.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = openDatabase(":memory:");

  db.prepare(
    `INSERT INTO T_THEME_THM (THM_ID, THM_NAME, THM_CREATED_AT) VALUES (?, ?, ?)`
  ).run("thm-1", "Science", "2026-03-17T10:00:00.000Z");

  // MCQ questions
  for (let i = 1; i <= 2; i++) {
    db.prepare(
      `INSERT INTO T_QUESTION_QST
         (QST_ID, QST_TYPE, QST_THEME_ID, QST_TITLE,
          QST_CHOICE_A, QST_CHOICE_B, QST_CHOICE_C, QST_CHOICE_D,
          QST_CORRECT_ANSWER, QST_LEVEL, QST_TIME_LIMIT, QST_POINTS, QST_CREATED_AT)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `qst-${i}`, "MCQ", "thm-1",
      `Question ${i}`,
      "Paris", "Lyon", "Marseille", "Toulouse",
      "Paris", 1, 30, 10, "2026-03-17T10:00:00.000Z"
    );
  }

  // SPEED question
  db.prepare(
    `INSERT INTO T_QUESTION_QST
       (QST_ID, QST_TYPE, QST_THEME_ID, QST_TITLE,
        QST_CHOICE_A, QST_CHOICE_B, QST_CHOICE_C, QST_CHOICE_D,
        QST_CORRECT_ANSWER, QST_LEVEL, QST_TIME_LIMIT, QST_POINTS, QST_CREATED_AT)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "qst-speed", "SPEED", "thm-1",
    "Speed question",
    null, null, null, null,
    "42", 1, 30, 20, "2026-03-17T10:00:00.000Z"
  );

  db.prepare(
    `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT) VALUES (?, ?, ?)`
  ).run("quiz-1", "Mon quiz", "2026-03-17T10:00:00.000Z");

  // Quiz with 1 MCQ question (for last question → COMPLETED test)
  db.prepare(
    `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT) VALUES (?, ?, ?)`
  ).run("quiz-single", "Single Q", "2026-03-17T10:00:00.000Z");

  // Quiz with 1 SPEED question
  db.prepare(
    `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT) VALUES (?, ?, ?)`
  ).run("quiz-speed", "Speed Q", "2026-03-17T10:00:00.000Z");

  db.prepare(
    `INSERT INTO T_QUIZ_QUESTION_QQN (QQN_QUIZ_ID, QQN_QUESTION_ID, QQN_ORDER) VALUES (?, ?, ?)`
  ).run("quiz-1", "qst-1", 1);
  db.prepare(
    `INSERT INTO T_QUIZ_QUESTION_QQN (QQN_QUIZ_ID, QQN_QUESTION_ID, QQN_ORDER) VALUES (?, ?, ?)`
  ).run("quiz-1", "qst-2", 2);
  db.prepare(
    `INSERT INTO T_QUIZ_QUESTION_QQN (QQN_QUIZ_ID, QQN_QUESTION_ID, QQN_ORDER) VALUES (?, ?, ?)`
  ).run("quiz-single", "qst-1", 1);
  db.prepare(
    `INSERT INTO T_QUIZ_QUESTION_QQN (QQN_QUIZ_ID, QQN_QUESTION_ID, QQN_ORDER) VALUES (?, ?, ?)`
  ).run("quiz-speed", "qst-speed", 1);

  return db;
}

function insertGame(db, gameId, quizId) {
  db.prepare(
    `INSERT INTO T_GAME_GAM (GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CURRENT_QUESTION_INDEX, GAM_CREATED_AT)
     VALUES (?, ?, 'OPEN', 0, ?)`
  ).run(gameId, quizId, "2026-03-17T10:00:00.000Z");

  for (let i = 1; i <= 3; i++) {
    db.prepare(
      `INSERT INTO T_GAME_PARTICIPANT_GPA (GPA_GAME_ID, GPA_NAME, GPA_ORDER) VALUES (?, ?, ?)`
    ).run(gameId, ["Alice", "Bob", "Charlie"][i - 1], i);
  }
}

function createMockSender() {
  const messages = [];
  const systemSounds = [];
  return {
    messages,
    systemSounds,
    broadcast: (msg) => messages.push({ target: "broadcast", ...msg }),
    sendToAdmin: (msg) => messages.push({ target: "admin", ...msg }),
    sendToBuzzer: (order, msg) => messages.push({ target: `buzzer-${order}`, ...msg }),
    sendSystemSoundToBuzzer: (order, soundId) => systemSounds.push({ target: `buzzer-${order}`, sound_id: soundId }),
    broadcastSystemSound: (soundId) => systemSounds.push({ target: "all_buzzers", sound_id: soundId }),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("gameOrchestrator — US-018 system sound auto-triggers", () => {
  let db;

  beforeEach(() => {
    jest.useFakeTimers();
    db = createTestDb();
  });

  afterEach(() => {
    jest.useRealTimers();
    db.close();
  });

  // ── CA-1: buzz_accepted → BUZZ_PRESSED ──────────────────────────────────

  test("CA-1 — sends BUZZ_PRESSED to buzzer on buzz_accepted (SPEED)", () => {
    insertGame(db, "gam-1", "quiz-speed");
    const sender = createMockSender();
    const orch = createGameOrchestrator(db, sender);

    // Start SPEED question
    orch.handleTriggerTitle();
    sender.systemSounds.length = 0;

    // Buzz
    orch.handleBuzz("sub-1", "Alice", 1);

    const buzzSound = sender.systemSounds.find(
      (s) => s.target === "buzzer-1" && s.sound_id === "BUZZ_PRESSED"
    );
    expect(buzzSound).toBeDefined();
  });

  // ── CA-2: buzz_locked → BUZZ_LOCKED to other buzzers ──────────────────────

  test("CA-2 — sends BUZZ_LOCKED to non-buzzer buzzers on buzz_locked", () => {
    insertGame(db, "gam-1", "quiz-speed");
    const sender = createMockSender();
    const orch = createGameOrchestrator(db, sender);

    orch.handleTriggerTitle();
    sender.systemSounds.length = 0;

    orch.handleBuzz("sub-1", "Alice", 1);

    // Buzzers 2 and 3 should get BUZZ_LOCKED
    const lockSounds = sender.systemSounds.filter((s) => s.sound_id === "BUZZ_LOCKED");
    expect(lockSounds).toEqual(
      expect.arrayContaining([
        { target: "buzzer-2", sound_id: "BUZZ_LOCKED" },
        { target: "buzzer-3", sound_id: "BUZZ_LOCKED" },
      ])
    );

    // Buzzer 1 (the one who buzzed) should NOT get BUZZ_LOCKED
    const buzzer1Lock = lockSounds.find((s) => s.target === "buzzer-1");
    expect(buzzer1Lock).toBeUndefined();
  });

  // ── CA-3: buzz_invalidated → BUZZ_INVALIDATED ────────────────────────────

  test("CA-3 — sends BUZZ_INVALIDATED to invalidated buzzer", async () => {
    insertGame(db, "gam-1", "quiz-speed");
    const sender = createMockSender();
    const orch = createGameOrchestrator(db, sender);

    orch.handleTriggerTitle();
    orch.handleBuzz("sub-1", "Alice", 1);
    sender.systemSounds.length = 0;

    await orch.handleInvalidateAnswer();

    const invalidateSound = sender.systemSounds.find(
      (s) => s.target === "buzzer-1" && s.sound_id === "BUZZ_INVALIDATED"
    );
    expect(invalidateSound).toBeDefined();
  });

  // ── CA-4: question_result correct → CORRECT_ANSWER (MCQ) ─────────────────

  test("CA-4 — sends CORRECT_ANSWER on correct question_result (MCQ)", async () => {
    insertGame(db, "gam-1", "quiz-single");
    const sender = createMockSender();
    const orch = createGameOrchestrator(db, sender);

    orch.handleTriggerTitle();
    orch.handleTriggerChoices();
    sender.systemSounds.length = 0;

    // All participants answer
    orch.handleAnswer(1, "A", 1000); // Correct (Paris = A)
    orch.handleAnswer(2, "B", 1500); // Wrong
    orch.handleAnswer(3, "A", 2000); // Correct

    // Trigger correction
    jest.advanceTimersByTime(30000); // Let timer expire
    await orch.handleTriggerCorrection();

    const correctSounds = sender.systemSounds.filter((s) => s.sound_id === "CORRECT_ANSWER");
    const wrongSounds = sender.systemSounds.filter((s) => s.sound_id === "WRONG_ANSWER");

    expect(correctSounds).toEqual(
      expect.arrayContaining([
        { target: "buzzer-1", sound_id: "CORRECT_ANSWER" },
        { target: "buzzer-3", sound_id: "CORRECT_ANSWER" },
      ])
    );

    expect(wrongSounds).toEqual([{ target: "buzzer-2", sound_id: "WRONG_ANSWER" }]);
  });

  // ── CA-5: question_result wrong → WRONG_ANSWER (MCQ) ─────────────────────

  test("CA-5 — sends WRONG_ANSWER on incorrect question_result (MCQ)", async () => {
    insertGame(db, "gam-1", "quiz-single");
    const sender = createMockSender();
    const orch = createGameOrchestrator(db, sender);

    orch.handleTriggerTitle();
    orch.handleTriggerChoices();
    sender.systemSounds.length = 0;

    orch.handleAnswer(1, "B", 1000); // Wrong
    orch.handleAnswer(2, "C", 1500); // Wrong
    orch.handleAnswer(3, "D", 2000); // Wrong

    jest.advanceTimersByTime(30000);
    await orch.handleTriggerCorrection();

    const wrongSounds = sender.systemSounds.filter((s) => s.sound_id === "WRONG_ANSWER");
    expect(wrongSounds).toHaveLength(3);
  });

  // ── CA-4/CA-5: SPEED validate → CORRECT/WRONG ────────────────────────────

  test("CA-4/CA-5 — sends CORRECT_ANSWER to winner and WRONG_ANSWER to others (SPEED validate)", async () => {
    insertGame(db, "gam-1", "quiz-speed");
    const sender = createMockSender();
    const orch = createGameOrchestrator(db, sender);

    orch.handleTriggerTitle();
    orch.handleBuzz("sub-1", "Alice", 1);
    sender.systemSounds.length = 0;

    await orch.handleValidateAnswer();

    const correctSounds = sender.systemSounds.filter((s) => s.sound_id === "CORRECT_ANSWER");
    const wrongSounds = sender.systemSounds.filter((s) => s.sound_id === "WRONG_ANSWER");

    expect(correctSounds).toEqual([{ target: "buzzer-1", sound_id: "CORRECT_ANSWER" }]);
    expect(wrongSounds).toEqual(
      expect.arrayContaining([
        { target: "buzzer-2", sound_id: "WRONG_ANSWER" },
        { target: "buzzer-3", sound_id: "WRONG_ANSWER" },
      ])
    );
  });

  // ── CA-4/CA-5: SPEED no winner (timer expire) → WRONG_ANSWER to all ──────

  test("CA-4/CA-5 — sends WRONG_ANSWER to all when SPEED timer expires with no winner", () => {
    insertGame(db, "gam-1", "quiz-speed");
    const sender = createMockSender();
    const orch = createGameOrchestrator(db, sender);

    orch.handleTriggerTitle();
    sender.systemSounds.length = 0;

    // Let timer expire
    jest.advanceTimersByTime(30000);

    const wrongSounds = sender.systemSounds.filter((s) => s.sound_id === "WRONG_ANSWER");
    expect(wrongSounds).toHaveLength(3);
  });

  // ── CA-6: timer_end → TIMER_END (MCQ) ────────────────────────────────────

  test("CA-6 — sends TIMER_END broadcast on MCQ timer expiration", () => {
    insertGame(db, "gam-1", "quiz-single");
    const sender = createMockSender();
    const orch = createGameOrchestrator(db, sender);

    orch.handleTriggerTitle();
    orch.handleTriggerChoices();
    sender.systemSounds.length = 0;

    // Let timer expire
    jest.advanceTimersByTime(30000);

    const timerSounds = sender.systemSounds.filter((s) => s.sound_id === "TIMER_END");
    expect(timerSounds).toEqual([{ target: "all_buzzers", sound_id: "TIMER_END" }]);
  });

  // ── CA-6: timer_end → TIMER_END (SPEED, normal expiration) ────────────────

  test("CA-6 — sends TIMER_END broadcast on SPEED timer expiration (QUESTION_OPEN)", () => {
    insertGame(db, "gam-1", "quiz-speed");
    const sender = createMockSender();
    const orch = createGameOrchestrator(db, sender);

    orch.handleTriggerTitle();
    sender.systemSounds.length = 0;

    jest.advanceTimersByTime(30000);

    const timerSounds = sender.systemSounds.filter((s) => s.sound_id === "TIMER_END");
    expect(timerSounds).toEqual([{ target: "all_buzzers", sound_id: "TIMER_END" }]);
  });

  // ── CA-6: timer_end during QUESTION_BUZZED → no TIMER_END broadcast ──────

  test("CA-6 — no TIMER_END broadcast when timer expires during QUESTION_BUZZED (sendToAdmin only)", () => {
    insertGame(db, "gam-1", "quiz-speed");
    const sender = createMockSender();
    const orch = createGameOrchestrator(db, sender);

    orch.handleTriggerTitle();
    orch.handleBuzz("sub-1", "Alice", 1);
    sender.systemSounds.length = 0;

    // Timer expires during QUESTION_BUZZED → only admin gets timer_end
    jest.advanceTimersByTime(30000);

    const timerSounds = sender.systemSounds.filter((s) => s.sound_id === "TIMER_END");
    expect(timerSounds).toEqual([]); // No broadcast
  });

  // ── CA-8: COMPLETED → GAME_END ───────────────────────────────────────────

  test("CA-8 — sends GAME_END broadcast on last question → COMPLETED", async () => {
    insertGame(db, "gam-1", "quiz-single"); // Only 1 question
    const sender = createMockSender();
    const orch = createGameOrchestrator(db, sender);

    // Play the single MCQ question
    orch.handleTriggerTitle();
    orch.handleTriggerChoices();
    orch.handleAnswer(1, "A", 1000);
    orch.handleAnswer(2, "A", 1500);
    orch.handleAnswer(3, "A", 2000);
    jest.advanceTimersByTime(30000);
    await orch.handleTriggerCorrection();

    sender.systemSounds.length = 0;

    // Trigger next question → should transition to COMPLETED
    orch.handleTriggerNextQuestion();

    const gameEndSounds = sender.systemSounds.filter((s) => s.sound_id === "GAME_END");
    expect(gameEndSounds).toEqual([{ target: "all_buzzers", sound_id: "GAME_END" }]);
  });

  // ── CA-8: next question available → no GAME_END ──────────────────────────

  test("CA-8 — no GAME_END when more questions remain", async () => {
    insertGame(db, "gam-1", "quiz-1"); // 2 questions
    const sender = createMockSender();
    const orch = createGameOrchestrator(db, sender);

    // Play first question
    orch.handleTriggerTitle();
    orch.handleTriggerChoices();
    orch.handleAnswer(1, "A", 1000);
    orch.handleAnswer(2, "A", 1500);
    orch.handleAnswer(3, "A", 2000);
    jest.advanceTimersByTime(30000);
    await orch.handleTriggerCorrection();

    sender.systemSounds.length = 0;

    // Trigger next → should stay OPEN (more questions)
    orch.handleTriggerNextQuestion();

    const gameEndSounds = sender.systemSounds.filter((s) => s.sound_id === "GAME_END");
    expect(gameEndSounds).toEqual([]);
  });
});
