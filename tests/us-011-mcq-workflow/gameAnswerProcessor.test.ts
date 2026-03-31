import {
  createAnswerProcessor,
} from "../../src/game/gameAnswerProcessor.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates a processor for a typical 3-participant MCQ question.
 * @param {Object} [overrides]
 * @returns {ReturnType<typeof createAnswerProcessor>}
 */
function makeProcessor(overrides = {}) {
  return createAnswerProcessor({
    questionId: "qst-1",
    correctAnswer: "A",
    points: 10,
    timeLimitMs: 30_000,
    participantOrders: [1, 2, 3],
    cumulativeScores: { 1: 20, 2: 10, 3: 0 },
    ...overrides,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("gameAnswerProcessor", () => {

  // ── Creation ──────────────────────────────────────────────────────────────

  describe("createAnswerProcessor", () => {
    it("returns an object with the expected API", () => {
      const processor = makeProcessor();
      expect(processor).toHaveProperty("recordAnswer");
      expect(processor).toHaveProperty("allAnswered");
      expect(processor).toHaveProperty("hasAnswered");
      expect(processor).toHaveProperty("getResults");
      expect(processor).toHaveProperty("expire");
      expect(processor).toHaveProperty("isExpired");
    });

    it("starts with no answers and not expired", () => {
      const processor = makeProcessor();
      expect(processor.allAnswered()).toBe(false);
      expect(processor.isExpired()).toBe(false);
    });
  });

  // ── recordAnswer — CA-13 valid answer ─────────────────────────────────────

  describe("recordAnswer — CA-13", () => {
    it("CA-13: records a valid answer and returns accepted result", () => {
      const processor = makeProcessor();
      const result = processor.recordAnswer(1, "A", 3100);

      expect(result.accepted).toBe(true);
      expect(result.participantOrder).toBe(1);
      expect(result.answer).toBe("A");
      expect(result.timeMs).toBe(3100);
    });

    it("CA-13: records answers for different participants", () => {
      const processor = makeProcessor();
      processor.recordAnswer(1, "A", 3100);
      processor.recordAnswer(2, "C", 5200);

      expect(processor.hasAnswered(1)).toBe(true);
      expect(processor.hasAnswered(2)).toBe(true);
      expect(processor.hasAnswered(3)).toBe(false);
    });
  });

  // ── CA-16 : allAnswered ───────────────────────────────────────────────────

  describe("allAnswered — CA-16", () => {
    it("CA-16: returns false when not all participants have answered", () => {
      const processor = makeProcessor();
      processor.recordAnswer(1, "A", 3100);
      expect(processor.allAnswered()).toBe(false);
    });

    it("CA-16: returns true when all participants have answered", () => {
      const processor = makeProcessor();
      processor.recordAnswer(1, "A", 3100);
      processor.recordAnswer(2, "B", 4000);
      processor.recordAnswer(3, "C", 5000);
      expect(processor.allAnswered()).toBe(true);
    });
  });

  // ── CA-18 : duplicate answer ──────────────────────────────────────────────

  describe("duplicate answer — CA-18", () => {
    it("CA-18: rejects a second answer from the same participant", () => {
      const processor = makeProcessor();
      processor.recordAnswer(1, "A", 3100);
      const result = processor.recordAnswer(1, "B", 5000);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("DUPLICATE_ANSWER");
    });

    it("CA-18: first answer is preserved when duplicate is rejected", () => {
      const processor = makeProcessor();
      processor.recordAnswer(1, "A", 3100);
      processor.recordAnswer(1, "B", 5000); // rejected

      const results = processor.getResults();
      const p1 = results.find((r) => r.participantOrder === 1);
      expect(p1.answer).toBe("A");
      expect(p1.timeMs).toBe(3100);
    });
  });

  // ── CA-19 : invalid answer value ──────────────────────────────────────────

  describe("invalid answer value — CA-19", () => {
    it("CA-19: rejects answer with value other than A, B, C, D", () => {
      const processor = makeProcessor();
      const result = processor.recordAnswer(1, "E", 3100);
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("INVALID_ANSWER");
    });

    it("CA-19: rejects empty string answer", () => {
      const processor = makeProcessor();
      const result = processor.recordAnswer(1, "", 3100);
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("INVALID_ANSWER");
    });

    it("CA-19: rejects null answer", () => {
      const processor = makeProcessor();
      const result = processor.recordAnswer(1, null, 3100);
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("INVALID_ANSWER");
    });
  });

  // ── CA-20 : answer after expiration ───────────────────────────────────────

  describe("answer after expiration — CA-20", () => {
    it("CA-20: rejects answer received after expire() was called", () => {
      const processor = makeProcessor();
      processor.expire();
      const result = processor.recordAnswer(1, "A", 3100);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("TIMER_EXPIRED");
    });

    it("CA-20: isExpired returns true after expire()", () => {
      const processor = makeProcessor();
      processor.expire();
      expect(processor.isExpired()).toBe(true);
    });
  });

  // ── CA-21 : participant not in game ───────────────────────────────────────

  describe("participant not in game — CA-21", () => {
    it("CA-21: rejects answer from participant not in participantOrders", () => {
      const processor = makeProcessor();
      const result = processor.recordAnswer(9, "A", 3100);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("UNKNOWN_PARTICIPANT");
    });
  });

  // ── expire — CA-11, CA-33 ────────────────────────────────────────────────

  describe("expire", () => {
    it("CA-11: expire is idempotent", () => {
      const processor = makeProcessor();
      processor.expire();
      expect(() => processor.expire()).not.toThrow();
      expect(processor.isExpired()).toBe(true);
    });

    it("answers recorded before expire are preserved", () => {
      const processor = makeProcessor();
      processor.recordAnswer(1, "A", 3100);
      processor.expire();

      const results = processor.getResults();
      const p1 = results.find((r) => r.participantOrder === 1);
      expect(p1.answer).toBe("A");
      expect(p1.timeMs).toBe(3100);
    });
  });

  // ── getResults — CA-23, CA-24, CA-25, CA-32, CA-33 ───────────────────────

  describe("getResults — scoring", () => {
    it("CA-23: correct answer earns points, wrong answer earns 0", () => {
      const processor = makeProcessor({ correctAnswer: "A", points: 10 });
      processor.recordAnswer(1, "A", 3100); // correct
      processor.recordAnswer(2, "C", 5200); // wrong
      processor.recordAnswer(3, "A", 4000); // correct

      const results = processor.getResults();

      const p1 = results.find((r) => r.participantOrder === 1);
      expect(p1.correct).toBe(true);
      expect(p1.pointsEarned).toBe(10);

      const p2 = results.find((r) => r.participantOrder === 2);
      expect(p2.correct).toBe(false);
      expect(p2.pointsEarned).toBe(0);

      const p3 = results.find((r) => r.participantOrder === 3);
      expect(p3.correct).toBe(true);
      expect(p3.pointsEarned).toBe(10);
    });

    it("CA-24: cumulativeScore includes previous score + pointsEarned", () => {
      const processor = makeProcessor({
        correctAnswer: "A",
        points: 10,
        cumulativeScores: { 1: 20, 2: 10, 3: 0 },
      });
      processor.recordAnswer(1, "A", 3100); // +10 → 30
      processor.recordAnswer(2, "B", 5200); // +0  → 10
      processor.recordAnswer(3, "A", 4000); // +10 → 10

      const results = processor.getResults();
      expect(results.find((r) => r.participantOrder === 1).cumulativeScore).toBe(30);
      expect(results.find((r) => r.participantOrder === 2).cumulativeScore).toBe(10);
      expect(results.find((r) => r.participantOrder === 3).cumulativeScore).toBe(10);
    });

    it("CA-33: unanswered participants get null answer, time_limit ms, 0 points", () => {
      const processor = makeProcessor({ timeLimitMs: 30_000, cumulativeScores: { 1: 20, 2: 10, 3: 0 } });
      processor.recordAnswer(1, "A", 3100);
      // participants 2 and 3 did not answer

      const results = processor.getResults();

      const p2 = results.find((r) => r.participantOrder === 2);
      expect(p2.answer).toBeNull();
      expect(p2.timeMs).toBe(30_000);
      expect(p2.pointsEarned).toBe(0);
      expect(p2.correct).toBe(false);
      expect(p2.cumulativeScore).toBe(10); // unchanged

      const p3 = results.find((r) => r.participantOrder === 3);
      expect(p3.answer).toBeNull();
      expect(p3.timeMs).toBe(30_000);
      expect(p3.pointsEarned).toBe(0);
      expect(p3.cumulativeScore).toBe(0); // unchanged
    });

    it("results are sorted by participantOrder", () => {
      const processor = makeProcessor();
      processor.recordAnswer(3, "A", 5000);
      processor.recordAnswer(1, "B", 3000);
      processor.recordAnswer(2, "A", 4000);

      const results = processor.getResults();
      expect(results.map((r) => r.participantOrder)).toEqual([1, 2, 3]);
    });

    it("each result contains questionId", () => {
      const processor = makeProcessor({ questionId: "qst-42" });
      processor.recordAnswer(1, "A", 3100);

      const results = processor.getResults();
      expect(results[0].questionId).toBe("qst-42");
    });
  });

  // ── getRanking — CA-25 ────────────────────────────────────────────────────

  describe("getRanking — CA-25", () => {
    it("CA-25: returns ranking sorted by cumulative score desc, then total time asc", () => {
      const processor = makeProcessor({
        correctAnswer: "A",
        points: 10,
        cumulativeScores: { 1: 35, 2: 25, 3: 30 },
      });
      // Alice (order 1): correct, fast → 35 + 10 = 45, time 3100
      processor.recordAnswer(1, "A", 3100);
      // Bob (order 2): wrong → 25, time 5200
      processor.recordAnswer(2, "C", 5200);
      // Charlie (order 3): correct, slower → 30 + 10 = 40, time 4000
      processor.recordAnswer(3, "A", 4000);

      const ranking = processor.getRanking();

      expect(ranking).toHaveLength(3);
      expect(ranking[0]).toMatchObject({ rank: 1, participantOrder: 1, cumulativeScore: 45 });
      expect(ranking[1]).toMatchObject({ rank: 2, participantOrder: 3, cumulativeScore: 40 });
      expect(ranking[2]).toMatchObject({ rank: 3, participantOrder: 2, cumulativeScore: 25 });
    });

    it("CA-25: tiebreaker is total time (lower is better)", () => {
      const processor = makeProcessor({
        correctAnswer: "A",
        points: 10,
        cumulativeScores: { 1: 0, 2: 0, 3: 0 },
      });
      // Both correct with same cumulative → tiebreak by timeMs
      processor.recordAnswer(1, "A", 5000);
      processor.recordAnswer(2, "A", 3000); // faster
      processor.recordAnswer(3, "B", 4000); // wrong

      const ranking = processor.getRanking();
      // P2 and P1 both have 10 pts, P2 faster
      expect(ranking[0].participantOrder).toBe(2);
      expect(ranking[1].participantOrder).toBe(1);
      expect(ranking[2].participantOrder).toBe(3);
    });

    it("CA-25: each ranking entry has rank, participantOrder, cumulativeScore, totalTimeMs", () => {
      const processor = makeProcessor();
      processor.recordAnswer(1, "A", 3100);
      processor.recordAnswer(2, "B", 5000);
      processor.recordAnswer(3, "A", 4000);

      const ranking = processor.getRanking();
      for (const entry of ranking) {
        expect(entry).toHaveProperty("rank");
        expect(entry).toHaveProperty("participantOrder");
        expect(entry).toHaveProperty("cumulativeScore");
        expect(entry).toHaveProperty("totalTimeMs");
      }
    });
  });

  // ── connectedOrders — CA-16 with disconnected buzzers ─────────────────────

  describe("allAnswered with connectedOrders", () => {
    it("allAnswered considers only connected participants when provided", () => {
      const processor = makeProcessor({ connectedOrders: new Set([1, 2]) });
      // Participant 3 is disconnected
      processor.recordAnswer(1, "A", 3100);
      processor.recordAnswer(2, "B", 5200);

      expect(processor.allAnswered()).toBe(true);
    });

    it("allAnswered returns false if a connected participant has not answered", () => {
      const processor = makeProcessor({ connectedOrders: new Set([1, 2]) });
      processor.recordAnswer(1, "A", 3100);

      expect(processor.allAnswered()).toBe(false);
    });

    it("allAnswered falls back to all participants when connectedOrders is null", () => {
      const processor = makeProcessor({ connectedOrders: null });
      processor.recordAnswer(1, "A", 3100);
      processor.recordAnswer(2, "B", 5200);

      expect(processor.allAnswered()).toBe(false); // 3 not answered
    });
  });
});