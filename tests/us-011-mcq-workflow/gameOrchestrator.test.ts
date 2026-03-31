import { jest } from "@jest/globals";
import { openDatabase } from "../../src/database/database.ts";
import { createGameOrchestrator } from "../../src/game/gameOrchestrator.ts";

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("gameOrchestrator", () => {
  let db;

  beforeEach(() => {
    jest.useFakeTimers();
    db = createTestDb();
  });
  afterEach(() => {
    jest.useRealTimers();
    db.close();
  });

  // ── trigger_title (CA-4, CA-5, CA-6, CA-7, CA-8) ───────────────────────────────

  describe("trigger_title", () => {
    it("CA-4: transitions to QUESTION_TITLE and broadcasts question_title", () => {
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      const result = orch.handleTriggerTitle();
      expect(result.ok).toBe(true);
      expect(getGameRow(db).GAM_STATUS).toBe("QUESTION_TITLE");
      const broadcast = mock.messages.find((m) => m.type === "question_title");
      expect(broadcast).toBeDefined();
      expect(broadcast.target).toBe("broadcast");
    });

    it("CA-5: question_title contains index, type, title, time_limit", () => {
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      orch.handleTriggerTitle();
      const msg = mock.messages.find((m) => m.type === "question_title");
      expect(msg.question_index).toBe(0);
      expect(msg.question_type).toBe("MCQ");
      expect(msg.title).toBeDefined();
      expect(msg.time_limit).toBe(30);
    });

    it("CA-6: returns error INVALID_STATE when state is PENDING (game never started)", () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'PENDING' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      const result = orch.handleTriggerTitle();
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("INVALID_STATE");
    });

    it("CA-7: returns error INVALID_STATE when state is not OPEN (other states)", () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      const result = orch.handleTriggerTitle();
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("INVALID_STATE");
    });

    it("CA-8: returns error NO_MORE_QUESTIONS when index is out of bounds", () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_CURRENT_QUESTION_INDEX = 99 WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      const result = orch.handleTriggerTitle();
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("NO_MORE_QUESTIONS");
    });

    it("returns error when no active game exists", () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'COMPLETED' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      const result = orch.handleTriggerTitle();
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("NO_ACTIVE_GAME");
    });
  });

  // ── trigger_choices (CA-8, CA-10, CA-11, CA-12, CA-13) ─────────────────────

  describe("trigger_choices", () => {
    function setupQuestionTitle() {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");
    }

    it("CA-8: transitions to QUESTION_OPEN and broadcasts question_choices", () => {
      setupQuestionTitle();
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      const result = orch.handleTriggerChoices();
      expect(result.ok).toBe(true);
      expect(getGameRow(db).GAM_STATUS).toBe("QUESTION_OPEN");
      const broadcast = mock.messages.find((m) => m.type === "question_choices");
      expect(broadcast).toBeDefined();
      expect(broadcast.target).toBe("broadcast");
    });

    it("CA-10: question_choices contains choices, started_at, time_limit", () => {
      setupQuestionTitle();
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      orch.handleTriggerChoices();
      const msg = mock.messages.find((m) => m.type === "question_choices");
      expect(msg.choices).toEqual(["Paris", "Lyon", "Marseille", "Toulouse"]);
      expect(new Date(msg.started_at).toISOString()).toBe(msg.started_at);
      expect(msg.time_limit).toBe(30);
    });

    it("CA-11: emits timer_tick after tick interval", () => {
      setupQuestionTitle();
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      orch.handleTriggerChoices();
      jest.advanceTimersByTime(5_000);
      const ticks = mock.messages.filter((m) => m.type === "timer_tick");
      expect(ticks.length).toBeGreaterThanOrEqual(1);
      expect(ticks[0].remaining_seconds).toBeDefined();
      expect(ticks[0].target).toBe("broadcast");
    });

    it("CA-13: returns error INVALID_STATE when state is not QUESTION_TITLE", () => {
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      const result = orch.handleTriggerChoices();
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("INVALID_STATE");
    });

    it("CA-12: timer_end is broadcast when time expires", () => {
      setupQuestionTitle();
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      orch.handleTriggerChoices();
      jest.advanceTimersByTime(30_000);
      const timerEnd = mock.messages.find((m) => m.type === "timer_end");
      expect(timerEnd).toBeDefined();
      expect(timerEnd.target).toBe("broadcast");
    });

    it("CA-12: answer processor is expired when timer ends", () => {
      setupQuestionTitle();
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      orch.handleTriggerChoices();
      jest.advanceTimersByTime(30_000);
      const answerResult = orch.handleAnswer(1, "A", 31000);
      expect(answerResult.accepted).toBe(false);
      expect(answerResult.reason).toBe("TIMER_EXPIRED");
    });
  });

  // ── trigger_correction (CA-23 to CA-29) ───────────────────────────────────

  describe("trigger_correction", () => {
    it("CA-23 + CA-27: transitions to QUESTION_CLOSED when all answered", async () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      orch.handleTriggerChoices();
      orch.handleAnswer(1, "A", 3100);
      orch.handleAnswer(2, "C", 5200);
      orch.handleAnswer(3, "A", 4000);

      const result = await orch.handleTriggerCorrection();
      expect(result.ok).toBe(true);
      expect(getGameRow(db).GAM_STATUS).toBe("QUESTION_CLOSED");
    });

    it("CA-23: succeeds when timer expired (even if not all answered)", async () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      orch.handleTriggerChoices();
      orch.handleAnswer(1, "A", 3100);
      jest.advanceTimersByTime(30_000);

      const result = await orch.handleTriggerCorrection();
      expect(result.ok).toBe(true);
    });

    it("CA-25: sends question_result individually to each buzzer", async () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      orch.handleTriggerChoices();
      orch.handleAnswer(1, "A", 3100);
      orch.handleAnswer(2, "C", 5200);
      orch.handleAnswer(3, "A", 4000);

      await orch.handleTriggerCorrection();

      const buzzerResults = mock.messages.filter((m) => m.type === "question_result");
      expect(buzzerResults).toHaveLength(3);
      const p1 = buzzerResults.find((m) => m.target === "buzzer-1");
      expect(p1.correct_answer).toBe("A");
      expect(p1.player_answer).toBe("A");
      expect(p1.correct).toBe(true);
      expect(p1.points_earned).toBe(10);
      expect(p1.cumulative_score).toBe(10);
      const p2 = buzzerResults.find((m) => m.target === "buzzer-2");
      expect(p2.correct).toBe(false);
      expect(p2.points_earned).toBe(0);
    });

    it("CA-26: sends question_result_summary to admin", async () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      orch.handleTriggerChoices();
      orch.handleAnswer(1, "A", 3100);
      orch.handleAnswer(2, "C", 5200);
      orch.handleAnswer(3, "A", 4000);

      await orch.handleTriggerCorrection();

      const summary = mock.messages.find((m) => m.type === "question_result_summary");
      expect(summary).toBeDefined();
      expect(summary.target).toBe("admin");
      expect(summary.correct_answer).toBe("A");
      expect(summary.results).toHaveLength(3);
      expect(summary.ranking).toHaveLength(3);
      expect(summary.ranking[0].rank).toBe(1);
    });

    it("CA-28: returns error INVALID_STATE when state is not QUESTION_OPEN", async () => {
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      const result = await orch.handleTriggerCorrection();
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("INVALID_STATE");
    });

    it("CA-29: returns ANSWERS_PENDING when timer running and not all answered", async () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      orch.handleTriggerChoices();
      orch.handleAnswer(1, "A", 3100);

      const result = await orch.handleTriggerCorrection();
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("ANSWERS_PENDING");
    });

    it("CA-24: stops timer when correction triggered before expiration", async () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      orch.handleTriggerChoices();
      orch.handleAnswer(1, "A", 3100);
      orch.handleAnswer(2, "C", 5200);
      orch.handleAnswer(3, "A", 4000);

      await orch.handleTriggerCorrection();

      const messagesBefore = mock.messages.length;
      jest.advanceTimersByTime(30_000);
      const timerEnds = mock.messages.slice(messagesBefore).filter((m) => m.type === "timer_end");
      expect(timerEnds).toHaveLength(0);
    });
  });

  // ── trigger_next_question (CA-30, CA-31, CA-32) ───────────────────────────

  describe("trigger_next_question", () => {
    it("CA-30: increments index and transitions to OPEN", async () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      orch.handleTriggerChoices();
      orch.handleAnswer(1, "A", 3100);
      orch.handleAnswer(2, "C", 5200);
      orch.handleAnswer(3, "A", 4000);
      await orch.handleTriggerCorrection();

      const result = orch.handleTriggerNextQuestion();
      expect(result.ok).toBe(true);
      const row = getGameRow(db);
      expect(row.GAM_STATUS).toBe("OPEN");
      expect(row.GAM_CURRENT_QUESTION_INDEX).toBe(1);
    });

    it("CA-31: transitions to COMPLETED when last question", () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_CURRENT_QUESTION_INDEX = 11, GAM_STATUS = 'QUESTION_CLOSED' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      const result = orch.handleTriggerNextQuestion();
      expect(result.ok).toBe(true);
      expect(getGameRow(db).GAM_STATUS).toBe("COMPLETED");
    });

    it("CA-32: returns error INVALID_STATE when state is not QUESTION_CLOSED", () => {
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      const result = orch.handleTriggerNextQuestion();
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("INVALID_STATE");
    });

    it("CA-2: question index is persisted in DB", async () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      orch.handleTriggerChoices();
      orch.handleAnswer(1, "A", 3100);
      orch.handleAnswer(2, "C", 5200);
      orch.handleAnswer(3, "A", 4000);
      await orch.handleTriggerCorrection();

      orch.handleTriggerNextQuestion();
      expect(getGameRow(db).GAM_CURRENT_QUESTION_INDEX).toBe(1);
    });
  });

  // ── handleAnswer integration (CA-14 to CA-22) ────────────────────────────

  describe("handleAnswer — integration", () => {
    function setupQuestionOpen(orch) {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");
      orch.handleTriggerChoices();
    }

    it("CA-14 + CA-15: records answer and sends answer_received", () => {
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      setupQuestionOpen(orch);
      const result = orch.handleAnswer(1, "A", 3100);
      expect(result.accepted).toBe(true);
      expect(mock.messages.find((m) => m.type === "answer_received" && m.target === "buzzer-1")).toBeDefined();
    });

    it("CA-16: sends player_answered to admin", () => {
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      setupQuestionOpen(orch);
      orch.handleAnswer(2, "B", 5200);
      const notif = mock.messages.find((m) => m.type === "player_answered");
      expect(notif.participant_order).toBe(2);
      expect(notif.participant_name).toBe("Bob");
      expect(notif.answer).toBe("B");
      expect(notif.time_ms).toBe(5200);
    });

    it("CA-17: sends all_answered when all respond", () => {
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      setupQuestionOpen(orch);
      orch.handleAnswer(1, "A", 3100);
      orch.handleAnswer(2, "C", 5200);
      orch.handleAnswer(3, "A", 4000);
      expect(mock.messages.find((m) => m.type === "all_answered")).toBeDefined();
    });

    it("CA-17: does not send all_answered if incomplete", () => {
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      setupQuestionOpen(orch);
      orch.handleAnswer(1, "A", 3100);
      expect(mock.messages.find((m) => m.type === "all_answered")).toBeUndefined();
    });

    it("CA-18: rejects answer in wrong state", () => {
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      expect(orch.handleAnswer(1, "A", 3100).reason).toBe("INVALID_STATE");
    });

    it("CA-19: rejects duplicate", () => {
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      setupQuestionOpen(orch);
      orch.handleAnswer(1, "A", 3100);
      expect(orch.handleAnswer(1, "B", 5000).reason).toBe("DUPLICATE_ANSWER");
    });

    it("CA-20: rejects invalid value", () => {
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      setupQuestionOpen(orch);
      expect(orch.handleAnswer(1, "E", 3100).reason).toBe("INVALID_ANSWER");
    });

    it("CA-22: rejects unknown participant", () => {
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      setupQuestionOpen(orch);
      expect(orch.handleAnswer(9, "A", 3100).reason).toBe("UNKNOWN_PARTICIPANT");
    });
  });

  // ── Full cycle ────────────────────────────────────────────────────────────

  describe("full MCQ cycle", () => {
    it("CA-1: completes a full question cycle", async () => {
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);

      expect(orch.handleTriggerTitle().ok).toBe(true);
      expect(orch.handleTriggerChoices().ok).toBe(true);
      orch.handleAnswer(1, "A", 3100);
      orch.handleAnswer(2, "C", 5200);
      orch.handleAnswer(3, "A", 4000);
      expect((await orch.handleTriggerCorrection()).ok).toBe(true);
      expect(orch.handleTriggerNextQuestion().ok).toBe(true);
      expect(getGameRow(db).GAM_STATUS).toBe("OPEN");
      expect(getGameRow(db).GAM_CURRENT_QUESTION_INDEX).toBe(1);
    });

    it("completes two consecutive question cycles with cumulative scores", async () => {
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);

      // Q1
      orch.handleTriggerTitle();
      orch.handleTriggerChoices();
      orch.handleAnswer(1, "A", 3100);
      orch.handleAnswer(2, "C", 5200);
      orch.handleAnswer(3, "A", 4000);
      await orch.handleTriggerCorrection();
      orch.handleTriggerNextQuestion();

      // Q2
      orch.handleTriggerTitle();
      orch.handleTriggerChoices();
      orch.handleAnswer(1, "B", 2000);
      orch.handleAnswer(2, "A", 3000);
      orch.handleAnswer(3, "B", 4000);
      await orch.handleTriggerCorrection();

      const summaries = mock.messages.filter((m) => m.type === "question_result_summary");
      expect(summaries).toHaveLength(2);
      // Alice: Q1 correct (+10=10), Q2 wrong (+0=10)
      const alice = summaries[1].results.find((r) => r.participant_order === 1);
      expect(alice.cumulative_score).toBe(10);
    });
  });

  // ── trigger_intermediate_ranking (US-014) ──────────────────────────────────

  describe("trigger_intermediate_ranking", () => {
    it("CA-1: broadcasts intermediate_ranking in OPEN state", () => {
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      const result = orch.handleTriggerIntermediateRanking();
      expect(result.ok).toBe(true);
      const msg = mock.messages.find((m) => m.type === "intermediate_ranking");
      expect(msg).toBeDefined();
      expect(msg.target).toBe("broadcast");
      expect(msg.ranking).toHaveLength(3);
    });

    it("CA-2: broadcasts intermediate_ranking in QUESTION_TITLE without state change", () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      const result = orch.handleTriggerIntermediateRanking();
      expect(result.ok).toBe(true);
      expect(getGameRow(db).GAM_STATUS).toBe("QUESTION_TITLE");
      expect(mock.messages.find((m) => m.type === "intermediate_ranking")).toBeDefined();
    });

    it("CA-2: broadcasts intermediate_ranking in QUESTION_OPEN without state change", () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_OPEN' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      const result = orch.handleTriggerIntermediateRanking();
      expect(result.ok).toBe(true);
      expect(getGameRow(db).GAM_STATUS).toBe("QUESTION_OPEN");
    });

    it("CA-2: broadcasts intermediate_ranking in QUESTION_BUZZED without state change", () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_BUZZED' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      const result = orch.handleTriggerIntermediateRanking();
      expect(result.ok).toBe(true);
      expect(getGameRow(db).GAM_STATUS).toBe("QUESTION_BUZZED");
    });

    it("CA-2: broadcasts intermediate_ranking in QUESTION_CLOSED without state change", () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_CLOSED' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      const result = orch.handleTriggerIntermediateRanking();
      expect(result.ok).toBe(true);
      expect(getGameRow(db).GAM_STATUS).toBe("QUESTION_CLOSED");
    });

    it("CA-4: returns INVALID_STATE for PENDING", () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'PENDING' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      const result = orch.handleTriggerIntermediateRanking();
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("INVALID_STATE");
    });

    it("CA-4: returns INVALID_STATE for COMPLETED", () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'COMPLETED' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      const result = orch.handleTriggerIntermediateRanking();
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("NO_ACTIVE_GAME");
    });

    it("CA-4: returns INVALID_STATE for IN_ERROR", () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'IN_ERROR' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      const result = orch.handleTriggerIntermediateRanking();
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("NO_ACTIVE_GAME");
    });

    it("CA-5: returns all participants with score 0 when no questions played", () => {
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      orch.handleTriggerIntermediateRanking();
      const msg = mock.messages.find((m) => m.type === "intermediate_ranking");
      expect(msg.ranking).toHaveLength(3);
      for (const entry of msg.ranking) {
        expect(entry.cumulative_score).toBe(0);
        expect(entry.total_time_ms).toBe(0);
      }
    });

    it("CA-3: message contains rank, participant_name, participant_order, cumulative_score, total_time_ms", () => {
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      orch.handleTriggerIntermediateRanking();
      const msg = mock.messages.find((m) => m.type === "intermediate_ranking");
      for (const entry of msg.ranking) {
        expect(typeof entry.rank).toBe("number");
        expect(typeof entry.participant_name).toBe("string");
        expect(typeof entry.participant_order).toBe("number");
        expect(typeof entry.cumulative_score).toBe("number");
        expect(typeof entry.total_time_ms).toBe("number");
      }
    });

    it("CA-13: message content is identical for all clients (broadcast)", () => {
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      orch.handleTriggerIntermediateRanking();
      const broadcasts = mock.messages.filter((m) => m.type === "intermediate_ranking");
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].target).toBe("broadcast");
    });

    it("CA-14: does not affect game workflow state during question", async () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);

      // Trigger intermediate ranking during question
      orch.handleTriggerIntermediateRanking();

      // State unchanged
      expect(getGameRow(db).GAM_STATUS).toBe("QUESTION_TITLE");
    });

    it("CA-15: ranking is calculated on-the-fly, reflects persisted scores", async () => {
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);

      // Play Q1 through full cycle
      orch.handleTriggerTitle();
      orch.handleTriggerChoices();
      orch.handleAnswer(1, "A", 3100); // Alice: correct
      orch.handleAnswer(2, "C", 5200); // Bob: wrong
      orch.handleAnswer(3, "A", 4000); // Charlie: correct
      await orch.handleTriggerCorrection();
      orch.handleTriggerNextQuestion();

      // Now trigger intermediate ranking in OPEN state
      orch.handleTriggerIntermediateRanking();

      const msg = mock.messages.filter((m) => m.type === "intermediate_ranking");
      expect(msg).toHaveLength(1);
      const ranking = msg[0].ranking;
      expect(ranking).toHaveLength(3);

      // Alice and Charlie both scored 10, Alice was faster (3100 vs 4000)
      expect(ranking[0].cumulative_score).toBe(10);
      expect(ranking[1].cumulative_score).toBe(10);
      expect(ranking[2].cumulative_score).toBe(0);
      expect(ranking[2].participant_name).toBe("Bob");
    });

    it("returns NO_ACTIVE_GAME when no game exists", () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'COMPLETED' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);
      const result = orch.handleTriggerIntermediateRanking();
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("NO_ACTIVE_GAME");
    });
  });

  // ── No active game ────────────────────────────────────────────────────────

  describe("no active game", () => {
    it("all handlers return NO_ACTIVE_GAME", async () => {
      db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'COMPLETED' WHERE GAM_ID = ?").run("gam-1");
      const mock = createMockSend();
      const orch = createGameOrchestrator(db, mock);

      expect(orch.handleTriggerTitle().error.code).toBe("NO_ACTIVE_GAME");
      expect(orch.handleTriggerChoices().error.code).toBe("NO_ACTIVE_GAME");
      expect((await orch.handleTriggerCorrection()).error.code).toBe("NO_ACTIVE_GAME");
      expect(orch.handleTriggerNextQuestion().error.code).toBe("NO_ACTIVE_GAME");
    });
  });
});