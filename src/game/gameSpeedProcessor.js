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

/**
 * Crée un processeur pour une question SPEED.
 *
 * @param {Object} options
 * @param {string} options.questionId
 * @param {number} options.points - Points attribués au gagnant
 * @param {number} options.timeLimitMs - Durée totale en millisecondes
 * @param {number[]} options.participantOrders - Ordres des participants (1-based)
 * @param {Object<number, number>} options.cumulativeScores - Score cumulé par participant avant cette question
 */
export function createSpeedProcessor({
  questionId,
  points,
  timeLimitMs,
  participantOrders,
  cumulativeScores,
}) {
  /** @type {{ sub: string, username: string, participantOrder: number, timeMsAtBuzz: number } | null} */
  let currentBuzzer = null;

  /** Set of participant orders that have been invalidated on this question */
  const invalidated = new Set();

  /** Whether the timer expired while in QUESTION_BUZZED state */
  let timerExpiredDuringBuzz = false;

  /** Winner (set on validate) */
  let winner = null;

  const participantSet = new Set(participantOrders);

  /**
   * Records a buzz from a participant (CA-13).
   *
   * @param {string} sub - JWT sub of the buzzer
   * @param {string} username - Username of the buzzer
   * @param {number} participantOrder - 1-based order
   * @param {number} timeMsAtBuzz - Time elapsed since question start in ms
   * @returns {{ accepted: boolean, reason?: string }}
   */
  function recordBuzz(sub, username, participantOrder, timeMsAtBuzz) {
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
  function getCurrentBuzzer() {
    return currentBuzzer;
  }

  /**
   * Validates the current buzzer's answer (CA-19).
   * Sets the winner.
   *
   * @returns {{ participantOrder: number, timeMsAtBuzz: number, pointsEarned: number, cumulativeScore: number }}
   */
  function validate() {
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
   *
   * @returns {{ participantOrder: number, hasAvailablePlayers: boolean }}
   */
  function invalidate() {
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
  function hasAvailablePlayers() {
    for (const order of participantOrders) {
      if (!invalidated.has(order)) return true;
    }
    return false;
  }

  /**
   * Marks the timer as expired during QUESTION_BUZZED (CA-10).
   */
  function setTimerExpiredDuringBuzz() {
    timerExpiredDuringBuzz = true;
  }

  /**
   * @returns {boolean}
   */
  function hasTimerExpiredDuringBuzz() {
    return timerExpiredDuringBuzz;
  }

  /**
   * Gets the set of invalidated participant orders.
   * @returns {Set<number>}
   */
  function getInvalidated() {
    return invalidated;
  }

  /**
   * Computes individual results for each buzzer participant (CA-30).
   *
   * @returns {Array<{ participantOrder: number, correct: boolean, pointsEarned: number, cumulativeScore: number }>}
   */
  function getResults() {
    return participantOrders
      .slice()
      .sort((a, b) => a - b)
      .map((order) => {
        const previousScore = cumulativeScores[order] ?? 0;

        if (winner && winner.participantOrder === order) {
          return {
            participantOrder: order,
            correct: true,
            pointsEarned: winner.pointsEarned,
            cumulativeScore: winner.cumulativeScore,
          };
        }

        return {
          participantOrder: order,
          correct: false,
          pointsEarned: 0,
          cumulativeScore: previousScore,
        };
      });
  }

  /**
   * Computes the summary for Angular (CA-31).
   * `buzzers` contains only participants who actually buzzed (winner + invalidated).
   *
   * @param {Object<number, string>} names - Map of participantOrder → participantName
   * @returns {{ winner: Object|null, buzzers: Array, ranking: Array }}
   */
  function getSummary(names) {
    const results = getResults();

    // Winner info
    let winnerSummary = null;
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
    const buzzers = [];

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
    const ranking = results
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
