import { createSpeedProcessor } from "../src/game/gameSpeedProcessor.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createProcessor(overrides = {}) {
  return createSpeedProcessor({
    questionId: "qst-1",
    points: 20,
    timeLimitMs: 15000,
    participantOrders: [1, 2, 3],
    cumulativeScores: { 1: 10, 2: 20, 3: 30 },
    ...overrides,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("gameSpeedProcessor", () => {

  // ── recordBuzz ─────────────────────────────────────────────────────────────

  describe("recordBuzz", () => {
    it("CA-13: accepts a valid buzz from a participant", () => {
      const proc = createProcessor();
      const result = proc.recordBuzz("sub-1", "Alice", 1, 4000);
      expect(result.accepted).toBe(true);
    });

    it("CA-13: stores buzzer info after accepted buzz", () => {
      const proc = createProcessor();
      proc.recordBuzz("sub-3", "Charlie", 3, 4100);
      const buzzer = proc.getCurrentBuzzer();
      expect(buzzer).toEqual({
        sub: "sub-3",
        username: "Charlie",
        participantOrder: 3,
        timeMsAtBuzz: 4100,
      });
    });

    it("CA-17: rejects buzz from participant not in game", () => {
      const proc = createProcessor();
      const result = proc.recordBuzz("sub-99", "Unknown", 99, 5000);
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("NOT_IN_GAME");
    });

    it("CA-18: rejects buzz from already invalidated participant", () => {
      const proc = createProcessor();
      proc.recordBuzz("sub-1", "Alice", 1, 2000);
      proc.invalidate();
      const result = proc.recordBuzz("sub-1", "Alice", 1, 5000);
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("ALREADY_INVALIDATED");
    });

    it("CA-16: rejects buzz when another buzzer is already active", () => {
      const proc = createProcessor();
      proc.recordBuzz("sub-1", "Alice", 1, 2000);
      const result = proc.recordBuzz("sub-2", "Bob", 2, 3000);
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("BUZZ_ALREADY_ACTIVE");
    });
  });

  // ── getCurrentBuzzer ───────────────────────────────────────────────────────

  describe("getCurrentBuzzer", () => {
    it("returns null when no buzz active", () => {
      const proc = createProcessor();
      expect(proc.getCurrentBuzzer()).toBeNull();
    });

    it("returns buzzer info after buzz", () => {
      const proc = createProcessor();
      proc.recordBuzz("sub-2", "Bob", 2, 3500);
      expect(proc.getCurrentBuzzer().participantOrder).toBe(2);
    });
  });

  // ── validate ───────────────────────────────────────────────────────────────

  describe("validate", () => {
    it("CA-19: validates the current buzzer and returns winner data", () => {
      const proc = createProcessor();
      proc.recordBuzz("sub-3", "Charlie", 3, 4100);
      const winner = proc.validate();
      expect(winner.participantOrder).toBe(3);
      expect(winner.pointsEarned).toBe(20);
      expect(winner.cumulativeScore).toBe(50); // 30 + 20
      expect(winner.timeMsAtBuzz).toBe(4100);
    });

    it("throws when no active buzzer", () => {
      const proc = createProcessor();
      expect(() => proc.validate()).toThrow("NO_ACTIVE_BUZZER");
    });

    it("clears current buzzer after validation", () => {
      const proc = createProcessor();
      proc.recordBuzz("sub-1", "Alice", 1, 2000);
      proc.validate();
      expect(proc.getCurrentBuzzer()).toBeNull();
    });
  });

  // ── invalidate ─────────────────────────────────────────────────────────────

  describe("invalidate", () => {
    it("CA-21: invalidates the current buzzer and reports available players", () => {
      const proc = createProcessor();
      proc.recordBuzz("sub-1", "Alice", 1, 2000);
      const result = proc.invalidate();
      expect(result.participantOrder).toBe(1);
      expect(result.hasAvailablePlayers).toBe(true);
    });

    it("CA-24: reports no available players when all invalidated", () => {
      const proc = createProcessor({ participantOrders: [1] });
      proc.recordBuzz("sub-1", "Alice", 1, 2000);
      const result = proc.invalidate();
      expect(result.hasAvailablePlayers).toBe(false);
    });

    it("adds participant to invalidated set", () => {
      const proc = createProcessor();
      proc.recordBuzz("sub-1", "Alice", 1, 2000);
      proc.invalidate();
      expect(proc.getInvalidated().has(1)).toBe(true);
    });

    it("clears current buzzer after invalidation", () => {
      const proc = createProcessor();
      proc.recordBuzz("sub-1", "Alice", 1, 2000);
      proc.invalidate();
      expect(proc.getCurrentBuzzer()).toBeNull();
    });

    it("throws when no active buzzer", () => {
      const proc = createProcessor();
      expect(() => proc.invalidate()).toThrow("NO_ACTIVE_BUZZER");
    });
  });

  // ── hasAvailablePlayers ────────────────────────────────────────────────────

  describe("hasAvailablePlayers", () => {
    it("returns true initially", () => {
      const proc = createProcessor();
      expect(proc.hasAvailablePlayers()).toBe(true);
    });

    it("returns true when some players remain", () => {
      const proc = createProcessor();
      proc.recordBuzz("sub-1", "Alice", 1, 2000);
      proc.invalidate();
      expect(proc.hasAvailablePlayers()).toBe(true);
    });

    it("returns false when all invalidated", () => {
      const proc = createProcessor();
      // Invalidate 1
      proc.recordBuzz("sub-1", "Alice", 1, 2000);
      proc.invalidate();
      // Invalidate 2
      proc.recordBuzz("sub-2", "Bob", 2, 3000);
      proc.invalidate();
      // Invalidate 3
      proc.recordBuzz("sub-3", "Charlie", 3, 4000);
      proc.invalidate();
      expect(proc.hasAvailablePlayers()).toBe(false);
    });
  });

  // ── timerExpiredDuringBuzz ─────────────────────────────────────────────────

  describe("timerExpiredDuringBuzz", () => {
    it("CA-10: defaults to false", () => {
      const proc = createProcessor();
      expect(proc.hasTimerExpiredDuringBuzz()).toBe(false);
    });

    it("CA-10: can be set to true", () => {
      const proc = createProcessor();
      proc.setTimerExpiredDuringBuzz();
      expect(proc.hasTimerExpiredDuringBuzz()).toBe(true);
    });
  });

  // ── getResults ─────────────────────────────────────────────────────────────

  describe("getResults", () => {
    it("CA-30: returns correct results when there is a winner", () => {
      const proc = createProcessor();
      proc.recordBuzz("sub-3", "Charlie", 3, 4100);
      proc.validate();

      const results = proc.getResults();
      expect(results).toHaveLength(3);

      // Alice: no buzz, 0 points
      expect(results[0]).toEqual({
        participantOrder: 1,
        correct: false,
        pointsEarned: 0,
        cumulativeScore: 10,
      });

      // Bob: no buzz, 0 points
      expect(results[1]).toEqual({
        participantOrder: 2,
        correct: false,
        pointsEarned: 0,
        cumulativeScore: 20,
      });

      // Charlie: winner
      expect(results[2]).toEqual({
        participantOrder: 3,
        correct: true,
        pointsEarned: 20,
        cumulativeScore: 50,
      });
    });

    it("CA-9: returns all zeros when no winner (timer expired)", () => {
      const proc = createProcessor();
      const results = proc.getResults();
      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r.correct).toBe(false);
        expect(r.pointsEarned).toBe(0);
      }
    });

    it("handles missing cumulative scores gracefully", () => {
      const proc = createProcessor({ cumulativeScores: {} });
      proc.recordBuzz("sub-1", "Alice", 1, 2000);
      proc.validate();
      const results = proc.getResults();
      const winner = results.find(r => r.participantOrder === 1);
      expect(winner.cumulativeScore).toBe(20); // 0 + 20
    });
  });

  // ── getSummary ─────────────────────────────────────────────────────────────

  describe("getSummary", () => {
    const names = { 1: "Alice", 2: "Bob", 3: "Charlie" };

    it("CA-31: returns summary with winner", () => {
      const proc = createProcessor();
      proc.recordBuzz("sub-3", "Charlie", 3, 4100);
      proc.validate();

      const summary = proc.getSummary(names);

      // Winner
      expect(summary.winner).toEqual({
        participant_order: 3,
        participant_name: "Charlie",
        time_ms: 4100,
        points_earned: 20,
        cumulative_score: 50,
      });

      // Buzzers: only Charlie (winner)
      expect(summary.buzzers).toHaveLength(1);
      expect(summary.buzzers[0].status).toBe("winner");

      // Ranking: all 3 participants
      expect(summary.ranking).toHaveLength(3);
    });

    it("CA-31: returns summary with winner and invalidated buzzers", () => {
      const proc = createProcessor();

      // Alice buzzes and gets invalidated
      proc.recordBuzz("sub-1", "Alice", 1, 2000);
      proc.invalidate();

      // Charlie buzzes and wins
      proc.recordBuzz("sub-3", "Charlie", 3, 4100);
      proc.validate();

      const summary = proc.getSummary(names);

      // Buzzers: Alice (invalidated) + Charlie (winner)
      expect(summary.buzzers).toHaveLength(2);
      expect(summary.buzzers[0].participant_name).toBe("Alice");
      expect(summary.buzzers[0].status).toBe("invalidated");
      expect(summary.buzzers[1].participant_name).toBe("Charlie");
      expect(summary.buzzers[1].status).toBe("winner");
    });

    it("returns null winner when no winner (timer expired)", () => {
      const proc = createProcessor();
      const summary = proc.getSummary(names);
      expect(summary.winner).toBeNull();
      expect(summary.buzzers).toHaveLength(0);
    });

    it("ranking includes all participants sorted by score", () => {
      const proc = createProcessor();
      proc.recordBuzz("sub-3", "Charlie", 3, 4100);
      proc.validate();

      const summary = proc.getSummary(names);
      // Charlie: 50, Bob: 20, Alice: 10
      expect(summary.ranking[0].participant_name).toBe("Charlie");
      expect(summary.ranking[0].cumulative_score).toBe(50);
      expect(summary.ranking[1].participant_name).toBe("Bob");
      expect(summary.ranking[2].participant_name).toBe("Alice");
    });
  });

  // ── getInvalidated ─────────────────────────────────────────────────────────

  describe("getInvalidated", () => {
    it("returns empty set initially", () => {
      const proc = createProcessor();
      expect(proc.getInvalidated().size).toBe(0);
    });

    it("returns set with invalidated orders", () => {
      const proc = createProcessor();
      proc.recordBuzz("sub-1", "Alice", 1, 2000);
      proc.invalidate();
      proc.recordBuzz("sub-2", "Bob", 2, 3000);
      proc.invalidate();
      expect(proc.getInvalidated().size).toBe(2);
      expect(proc.getInvalidated().has(1)).toBe(true);
      expect(proc.getInvalidated().has(2)).toBe(true);
    });
  });
});
