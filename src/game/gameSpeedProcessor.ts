/**
 * Processeur de questions SPEED (US-012).
 *
 * Responsabilités :
 * - Gestion de l'état mémoire d'une question SPEED (buzzer courant, invalidés)
 * - Enregistrement des buzzes
 * - Validation / invalidation de la réponse orale
 * - Calcul des résultats et classement
 *
 * Ce module est sans état global : chaque question reçoit un nouveau processeur.
 */

import type { ISpeedProcessor, BuzzResult } from "../types/index.ts";

interface SpeedProcessorOptions {
  questionId: string;
  correctAnswer: string;
  points: number;
  timeLimitMs: number;
  participantOrders: number[];
  cumulativeScores: Record<number, number>;
}

interface BuzzerInfo {
  sub: string;
  username: string;
  participantOrder: number;
  timeMsAtBuzz: number;
}

interface WinnerInfo {
  participantOrder: number;
  username: string;
  timeMsAtBuzz: number;
  pointsEarned: number;
  cumulativeScore: number;
}

interface SpeedResult {
  participantOrder: number;
  correctAnswer: string;
  correct: boolean;
  pointsEarned: number;
  cumulativeScore: number;
}

interface BuzzerSummaryEntry {
  participant_order: number;
  participant_name: string;
  status: string;
  time_ms: number;
  points_earned: number;
  cumulative_score: number;
}

interface WinnerSummary {
  participant_order: number;
  participant_name: string;
  time_ms: number;
  points_earned: number;
  cumulative_score: number;
}

interface RankingSummaryEntry {
  rank: number;
  participant_name: string;
  cumulative_score: number;
  total_time_ms: number;
}

interface SpeedSummary {
  winner: WinnerSummary | null;
  buzzers: BuzzerSummaryEntry[];
  ranking: RankingSummaryEntry[];
}

/**
 * Crée un processeur pour une question SPEED.
 */
export function createSpeedProcessor({
  correctAnswer,
  points,
  timeLimitMs,
  participantOrders,
  cumulativeScores,
}: SpeedProcessorOptions): ISpeedProcessor {
  let currentBuzzer: BuzzerInfo | null = null;

  /** Set of participant orders that have been invalidated on this question */
  const invalidated = new Set<number>();

  /** Whether the timer expired while in QUESTION_BUZZED state */
  let timerExpiredDuringBuzz = false;

  /** Winner (set on validate) */
  let winner: WinnerInfo | null = null;

  const participantSet = new Set(participantOrders);

  /**
   * Records a buzz from a participant (CA-13).
   */
  function recordBuzz(sub: string, username: string, participantOrder: number, timeMsAtBuzz: number): BuzzResult {
    // CA-17: participant not in game
    if (!participantSet.has(participantOrder)) {
      return { accepted: false, reason: "NOT_IN_GAME" };
    }

    // CA-18: already invalidated on this question
    if (invalidated.has(participantOrder)) {
      return { accepted: false, reason: "ALREADY_INVALIDATED" };
    }

    // CA-16: already a buzzer active (shouldn't happen if state machine is correct)
    if (currentBuzzer !== null) {
      return { accepted: false, reason: "BUZZ_ALREADY_ACTIVE" };
    }

    currentBuzzer = { sub, username, participantOrder, timeMsAtBuzz };
    return { accepted: true };
  }

  /**
   * Returns the current buzzer info, or null.
   */
  function getCurrentBuzzer(): BuzzerInfo | null {
    return currentBuzzer;
  }

  /**
   * Validates the current buzzer's answer (CA-19).
   * Sets the winner.
   */
  function validate(): { participantOrder: number; timeMsAtBuzz: number; pointsEarned: number; cumulativeScore: number } {
    if (!currentBuzzer) {
      throw new Error("NO_ACTIVE_BUZZER");
    }

    const order = currentBuzzer.participantOrder;
    const previousScore = cumulativeScores[order] ?? 0;
    winner = {
      participantOrder: order,
      username: currentBuzzer.username,
      timeMsAtBuzz: currentBuzzer.timeMsAtBuzz,
      pointsEarned: points,
      cumulativeScore: previousScore + points,
    };

    currentBuzzer = null;
    return winner;
  }

  /**
   * Invalidates the current buzzer's answer (CA-21).
   */
  function invalidate(): { participantOrder: number; hasAvailablePlayers: boolean } {
    if (!currentBuzzer) {
      throw new Error("NO_ACTIVE_BUZZER");
    }

    const order = currentBuzzer.participantOrder;
    invalidated.add(order);
    currentBuzzer = null;

    return {
      participantOrder: order,
      hasAvailablePlayers: hasAvailablePlayers(),
    };
  }

  /**
   * Returns whether there are still players who can buzz (CA-24).
   */
  function hasAvailablePlayers(): boolean {
    for (const order of participantOrders) {
      if (!invalidated.has(order)) return true;
    }
    return false;
  }

  /**
   * Marks the timer as expired during QUESTION_BUZZED (CA-10).
   */
  function setTimerExpiredDuringBuzz(): void {
    timerExpiredDuringBuzz = true;
  }

  function hasTimerExpiredDuringBuzz(): boolean {
    return timerExpiredDuringBuzz;
  }

  /**
   * Gets the set of invalidated participant orders.
   */
  function getInvalidated(): Set<number> {
    return invalidated;
  }

  /**
   * Computes individual results for each buzzer participant (CA-30).
   */
  function getResults(): SpeedResult[] {
    return participantOrders
      .slice()
      .sort((a, b) => a - b)
      .map((order) => {
        const previousScore = cumulativeScores[order] ?? 0;

        if (winner && winner.participantOrder === order) {
          return {
            participantOrder: order,
            correctAnswer,
            correct: true,
            pointsEarned: winner.pointsEarned,
            cumulativeScore: winner.cumulativeScore,
          };
        }

        return {
          participantOrder: order,
          correctAnswer,
          correct: false,
          pointsEarned: 0,
          cumulativeScore: previousScore,
        };
      });
  }

  /**
   * Computes the summary for Angular (CA-31).
   * `buzzers` contains only participants who actually buzzed (winner + invalidated).
   */
  function getSummary(names: Record<number, string>): SpeedSummary {
    const results = getResults();

    // Winner info
    let winnerSummary: WinnerSummary | null = null;
    if (winner) {
      winnerSummary = {
        participant_order: winner.participantOrder,
        participant_name: names[winner.participantOrder],
        time_ms: winner.timeMsAtBuzz,
        points_earned: winner.pointsEarned,
        cumulative_score: winner.cumulativeScore,
      };
    }

    // Buzzers: only those who buzzed (winner + invalidated)
    const buzzers: BuzzerSummaryEntry[] = [];

    // Add invalidated buzzers (they buzzed but were invalidated)
    for (const order of invalidated) {
      const previousScore = cumulativeScores[order] ?? 0;
      buzzers.push({
        participant_order: order,
        participant_name: names[order],
        status: "invalidated",
        time_ms: timeLimitMs,
        points_earned: 0,
        cumulative_score: previousScore,
      });
    }

    // Add winner
    if (winner) {
      buzzers.push({
        participant_order: winner.participantOrder,
        participant_name: names[winner.participantOrder],
        status: "winner",
        time_ms: winner.timeMsAtBuzz,
        points_earned: winner.pointsEarned,
        cumulative_score: winner.cumulativeScore,
      });
    }

    // Sort buzzers by participant_order for consistency
    buzzers.sort((a, b) => a.participant_order - b.participant_order);

    // Ranking: all participants sorted by cumulative_score desc, then total_time_ms asc
    const ranking: RankingSummaryEntry[] = results
      .slice()
      .sort((a, b) => {
        if (b.cumulativeScore !== a.cumulativeScore) {
          return b.cumulativeScore - a.cumulativeScore;
        }
        // Use time from game answers for ranking (total_time_ms)
        return 0;
      })
      .map((entry, index) => ({
        rank: index + 1,
        participant_name: names[entry.participantOrder],
        cumulative_score: entry.cumulativeScore,
        total_time_ms: entry.participantOrder === winner?.participantOrder
          ? winner.timeMsAtBuzz
          : timeLimitMs,
      }));

    return { winner: winnerSummary, buzzers, ranking };
  }

  return {
    recordBuzz,
    getCurrentBuzzer,
    validate,
    invalidate,
    hasAvailablePlayers,
    setTimerExpiredDuringBuzz,
    hasTimerExpiredDuringBuzz,
    getInvalidated,
    getResults,
    getSummary,
  };
}
