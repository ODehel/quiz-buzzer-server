import { openDatabase } from "../../src/database/database.ts";
import { calculateIntermediateRanking } from "../../src/game/gameRankingCalculator.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = openDatabase(":memory:");

  db.prepare(
    `INSERT INTO T_THEME_THM (THM_ID, THM_NAME, THM_CREATED_AT) VALUES (?, ?, ?)`
  ).run("thm-1", "Science", "2026-03-17T10:00:00.000Z");

  for (let i = 1; i <= 3; i++) {
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

  db.prepare(
    `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT) VALUES (?, ?, ?)`
  ).run("quiz-1", "Mon quiz", "2026-03-17T10:00:00.000Z");

  for (let i = 1; i <= 3; i++) {
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
  db.prepare(
    `INSERT INTO T_GAME_PARTICIPANT_GPA (GPA_GAME_ID, GPA_NAME, GPA_ORDER) VALUES (?, ?, ?)`
  ).run("gam-1", "Charlie", 3);

  return db;
}

function insertAnswer(db, { participantOrder, questionId, answer, timeMs, pointsEarned, cumulativeScore, createdAt }) {
  db.prepare(
    `INSERT INTO T_GAME_ANSWER_GAA
       (GAA_ID, GAA_GAME_ID, GAA_QUESTION_ID, GAA_PARTICIPANT_ORDER,
        GAA_ANSWER, GAA_TIME_MS, GAA_POINTS_EARNED, GAA_CUMULATIVE_SCORE, GAA_CREATED_AT)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `gaa-${participantOrder}-${questionId}`, "gam-1", questionId, participantOrder,
    answer, timeMs, pointsEarned, cumulativeScore, createdAt
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("gameRankingCalculator", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  // CA-5: no questions played → all participants with score 0 and time 0
  it("CA-5: returns all participants with score 0 and time 0 when no answers exist", () => {
    const ranking = calculateIntermediateRanking(db, "gam-1");

    expect(ranking).toHaveLength(3);
    for (const entry of ranking) {
      expect(entry.cumulative_score).toBe(0);
      expect(entry.total_time_ms).toBe(0);
      expect(entry.participant_order).toBeDefined();
      expect(entry.participant_name).toBeDefined();
      expect(entry.rank).toBeDefined();
    }
  });

  // CA-7: ranking includes ALL participants, even those with score 0
  it("CA-7: includes all participants even when only some have answered", () => {
    insertAnswer(db, {
      participantOrder: 1, questionId: "qst-1", answer: "A",
      timeMs: 3000, pointsEarned: 10, cumulativeScore: 10,
      createdAt: "2026-03-17T10:01:00.000Z",
    });

    const ranking = calculateIntermediateRanking(db, "gam-1");

    expect(ranking).toHaveLength(3);
    expect(ranking[0].participant_name).toBe("Alice");
    expect(ranking[0].cumulative_score).toBe(10);
    // Bob and Charlie should have score 0
    const zeroScorers = ranking.filter((r) => r.cumulative_score === 0);
    expect(zeroScorers).toHaveLength(2);
  });

  // CA-6: sorted by cumulative_score DESC, then total_time_ms ASC
  it("CA-6: sorts by cumulative score descending, then total time ascending", () => {
    // Alice: 20pts, 8000ms
    insertAnswer(db, {
      participantOrder: 1, questionId: "qst-1", answer: "A",
      timeMs: 5000, pointsEarned: 10, cumulativeScore: 10,
      createdAt: "2026-03-17T10:01:00.000Z",
    });
    insertAnswer(db, {
      participantOrder: 1, questionId: "qst-2", answer: "A",
      timeMs: 3000, pointsEarned: 10, cumulativeScore: 20,
      createdAt: "2026-03-17T10:02:00.000Z",
    });

    // Bob: 10pts, 4000ms
    insertAnswer(db, {
      participantOrder: 2, questionId: "qst-1", answer: "B",
      timeMs: 2000, pointsEarned: 0, cumulativeScore: 0,
      createdAt: "2026-03-17T10:01:00.000Z",
    });
    insertAnswer(db, {
      participantOrder: 2, questionId: "qst-2", answer: "A",
      timeMs: 2000, pointsEarned: 10, cumulativeScore: 10,
      createdAt: "2026-03-17T10:02:00.000Z",
    });

    // Charlie: 20pts, 6000ms (tiebreaker with Alice — faster)
    insertAnswer(db, {
      participantOrder: 3, questionId: "qst-1", answer: "A",
      timeMs: 3000, pointsEarned: 10, cumulativeScore: 10,
      createdAt: "2026-03-17T10:01:00.000Z",
    });
    insertAnswer(db, {
      participantOrder: 3, questionId: "qst-2", answer: "A",
      timeMs: 3000, pointsEarned: 10, cumulativeScore: 20,
      createdAt: "2026-03-17T10:02:00.000Z",
    });

    const ranking = calculateIntermediateRanking(db, "gam-1");

    // Charlie (20pts, 6000ms) > Alice (20pts, 8000ms) > Bob (10pts, 4000ms)
    expect(ranking[0].participant_name).toBe("Charlie");
    expect(ranking[0].rank).toBe(1);
    expect(ranking[0].cumulative_score).toBe(20);
    expect(ranking[0].total_time_ms).toBe(6000);

    expect(ranking[1].participant_name).toBe("Alice");
    expect(ranking[1].rank).toBe(2);
    expect(ranking[1].cumulative_score).toBe(20);
    expect(ranking[1].total_time_ms).toBe(8000);

    expect(ranking[2].participant_name).toBe("Bob");
    expect(ranking[2].rank).toBe(3);
    expect(ranking[2].cumulative_score).toBe(10);
    expect(ranking[2].total_time_ms).toBe(4000);
  });

  // CA-8: uses only persisted data (MAX cumulative score)
  it("CA-8: cumulative score uses MAX from persisted answers", () => {
    // Q1: Alice gets 10pts
    insertAnswer(db, {
      participantOrder: 1, questionId: "qst-1", answer: "A",
      timeMs: 3000, pointsEarned: 10, cumulativeScore: 10,
      createdAt: "2026-03-17T10:01:00.000Z",
    });
    // Q2: Alice gets 0pts (wrong), cumulative stays 10
    insertAnswer(db, {
      participantOrder: 1, questionId: "qst-2", answer: "B",
      timeMs: 5000, pointsEarned: 0, cumulativeScore: 10,
      createdAt: "2026-03-17T10:02:00.000Z",
    });

    const ranking = calculateIntermediateRanking(db, "gam-1");
    const alice = ranking.find((r) => r.participant_name === "Alice");
    expect(alice.cumulative_score).toBe(10);
    expect(alice.total_time_ms).toBe(8000);
  });

  // CA-9: total_time_ms is sum of all GAA_TIME_MS
  it("CA-9: total_time_ms is the sum of all answer times", () => {
    insertAnswer(db, {
      participantOrder: 1, questionId: "qst-1", answer: "A",
      timeMs: 3000, pointsEarned: 10, cumulativeScore: 10,
      createdAt: "2026-03-17T10:01:00.000Z",
    });
    insertAnswer(db, {
      participantOrder: 1, questionId: "qst-2", answer: "A",
      timeMs: 5000, pointsEarned: 10, cumulativeScore: 20,
      createdAt: "2026-03-17T10:02:00.000Z",
    });

    const ranking = calculateIntermediateRanking(db, "gam-1");
    const alice = ranking.find((r) => r.participant_name === "Alice");
    expect(alice.total_time_ms).toBe(8000);
  });

  // participant_order is included in the ranking entries
  it("includes participant_order in each ranking entry", () => {
    const ranking = calculateIntermediateRanking(db, "gam-1");

    const orders = ranking.map((r) => r.participant_order).sort();
    expect(orders).toEqual([1, 2, 3]);
  });

  // SPEED question: only winner has a row — non-winners keep previous scores
  it("handles SPEED questions correctly (only winner has answer row)", () => {
    // Q1 (MCQ): all 3 participants answer
    insertAnswer(db, {
      participantOrder: 1, questionId: "qst-1", answer: "A",
      timeMs: 3000, pointsEarned: 10, cumulativeScore: 10,
      createdAt: "2026-03-17T10:01:00.000Z",
    });
    insertAnswer(db, {
      participantOrder: 2, questionId: "qst-1", answer: "A",
      timeMs: 4000, pointsEarned: 10, cumulativeScore: 10,
      createdAt: "2026-03-17T10:01:00.000Z",
    });
    insertAnswer(db, {
      participantOrder: 3, questionId: "qst-1", answer: "B",
      timeMs: 5000, pointsEarned: 0, cumulativeScore: 0,
      createdAt: "2026-03-17T10:01:00.000Z",
    });

    // Q2 (SPEED): only Bob (participant 2) wins
    insertAnswer(db, {
      participantOrder: 2, questionId: "qst-2", answer: "SPEED_WIN",
      timeMs: 2000, pointsEarned: 10, cumulativeScore: 20,
      createdAt: "2026-03-17T10:02:00.000Z",
    });

    const ranking = calculateIntermediateRanking(db, "gam-1");

    const bob = ranking.find((r) => r.participant_name === "Bob");
    expect(bob.cumulative_score).toBe(20);
    expect(bob.total_time_ms).toBe(6000); // 4000 + 2000

    const alice = ranking.find((r) => r.participant_name === "Alice");
    expect(alice.cumulative_score).toBe(10); // unchanged from Q1
    expect(alice.total_time_ms).toBe(3000); // only Q1 time

    const charlie = ranking.find((r) => r.participant_name === "Charlie");
    expect(charlie.cumulative_score).toBe(0); // wrong in Q1, no SPEED row
    expect(charlie.total_time_ms).toBe(5000); // only Q1 time
  });

  // Returns empty array for non-existent game
  it("returns empty array for a game with no participants", () => {
    const ranking = calculateIntermediateRanking(db, "non-existent-game");
    expect(ranking).toEqual([]);
  });
});
