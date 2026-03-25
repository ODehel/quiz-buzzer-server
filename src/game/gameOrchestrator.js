/**
 * Orchestrateur du workflow MCQ et SPEED (US-011 + US-012).
 *
 * Connecte les modules gameWorkflow, gameTimer, gameAnswerProcessor et
 * gameSpeedProcessor pour piloter le déroulement des questions depuis
 * les messages WebSocket.
 *
 * Responsabilités :
 * - Résoudre la partie active
 * - Valider les préconditions d'état pour chaque action
 * - Déléguer aux modules spécialisés
 * - Émettre les messages via les callbacks broadcast/send injectées (DIP)
 */

import { findActiveGame, updateGameQuestionIndex, getCumulativeScore, insertGameAnswers, insertGameAnswer } from "../repositories/gameanswerRepository.js";
import { v7 as uuidv7 } from "uuid";
import { findParticipantsByGameId, updateGameStatus } from "../repositories/gameRepository.js";
import { transitionState, resolveCurrentQuestion, hasMoreQuestions } from "./gameworkflow.js";
import { createGameTimer } from "./gameTimer.js";
import { createAnswerProcessor } from "./gameAnswerProcessor.js";
import { createSpeedProcessor } from "./gameSpeedProcessor.js";
import { persistWithRetry } from "./persistWithRetry.js";
import { logInfo, logWarn } from "../utils/logger.js";

/**
 * Crée un orchestrateur de partie MCQ + SPEED.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ broadcast: Function, sendToAdmin: Function, sendToBuzzer: Function }} sender
 * @param {Object} [options]
 * @param {Function} [options.persistFn] - Injectable pour les tests : remplace insertGameAnswers
 * @param {Object} [options.retryOptions] - Options pour persistWithRetry (maxRetries, baseDelayMs)
 * @returns {Object}
 */
export function createGameOrchestrator(db, sender, { persistFn, retryOptions } = {}) {
  /** @type {ReturnType<typeof createGameTimer>|null} */
  let currentTimer = null;

  /** @type {ReturnType<typeof createAnswerProcessor>|null} */
  let currentProcessor = null;

  /** @type {ReturnType<typeof createSpeedProcessor>|null} */
  let currentSpeedProcessor = null;

  /** Cached participant names by order for the current game */
  let participantNames = null;

  /** Current question being played (cached) */
  let currentQuestion = null;

  // ── Internal helpers ────────────────────────────────────────────────────

  function errorResult(code, message) {
    return { ok: false, error: { code, message } };
  }

  function okResult(data) {
    return { ok: true, ...data };
  }

  function loadActiveGame() {
    return findActiveGame(db);
  }

  function loadParticipantNames(gameId) {
    if (!participantNames) {
      const rows = findParticipantsByGameId(db, gameId);
      participantNames = {};
      for (const row of rows) {
        participantNames[row.GPA_ORDER] = row.GPA_NAME;
      }
    }
    return participantNames;
  }

  function loadCumulativeScores(gameId, orders) {
    const scores = {};
    for (const order of orders) {
      scores[order] = getCumulativeScore(db, gameId, order);
    }
    return scores;
  }

  function cleanupTimer() {
    if (currentTimer) {
      currentTimer.stop();
      currentTimer = null;
    }
  }

  // ── trigger_title (MCQ: CA-4 to CA-7; SPEED: US-012 CA-4 to CA-7) ────

  function handleTriggerTitle() {
    const game = loadActiveGame();
    if (!game) return errorResult("NO_ACTIVE_GAME", "No active game found.");

    // CA-6 : état doit être OPEN
    if (game.GAM_STATUS !== "OPEN") {
      return errorResult("INVALID_STATE", "This action is not allowed in the current game state.");
    }

    // CA-7 : résoudre la question courante
    const question = resolveCurrentQuestion(db, game.GAM_QUIZ_ID, game.GAM_CURRENT_QUESTION_INDEX);
    if (!question) {
      return errorResult("NO_MORE_QUESTIONS", "All questions have been played.");
    }

    // Reset state for new question
    currentProcessor = null;
    currentSpeedProcessor = null;
    cleanupTimer();
    participantNames = null;
    currentQuestion = question;

    // SPEED questions skip QUESTION_TITLE and go directly to QUESTION_OPEN (US-012 CA-4)
    if (question.QST_TYPE === "SPEED") {
      return handleSpeedTriggerTitle(game, question);
    }

    // MCQ: transition OPEN → QUESTION_TITLE (US-011 CA-4)
    transitionState(db, game.GAM_ID, "OPEN", "QUESTION_TITLE");

    // Broadcast question_title (US-011 CA-5)
    sender.broadcast({
      type: "question_title",
      question_index: game.GAM_CURRENT_QUESTION_INDEX,
      question_type: question.QST_TYPE,
      title: question.QST_TITLE,
      time_limit: question.QST_TIME_LIMIT,
    });

    return okResult();
  }

  // ── SPEED: trigger_title → QUESTION_OPEN directly ─────────────────────

  function handleSpeedTriggerTitle(game, question) {
    const names = loadParticipantNames(game.GAM_ID);
    const orders = Object.keys(names).map(Number);
    const cumulativeScores = loadCumulativeScores(game.GAM_ID, orders);

    // Create speed processor
    currentSpeedProcessor = createSpeedProcessor({
      questionId: question.QST_ID,
      correctAnswer: question.QST_CORRECT_ANSWER,
      points: question.QST_POINTS,
      timeLimitMs: question.QST_TIME_LIMIT * 1000,
      participantOrders: orders,
      cumulativeScores,
    });

    // Transition OPEN → QUESTION_OPEN (skip QUESTION_TITLE)
    transitionState(db, game.GAM_ID, "OPEN", "QUESTION_OPEN");

    logInfo("GAME_QUESTION_STATE_CHANGED", {
      game_id: game.GAM_ID,
      question_index: game.GAM_CURRENT_QUESTION_INDEX,
      new_status: "QUESTION_OPEN",
    });

    // Start timer with SPEED-specific behavior
    currentTimer = createGameTimer({
      timeLimitSeconds: question.QST_TIME_LIMIT,
      onTick: (remainingSeconds) => {
        sender.broadcast({
          type: "timer_tick",
          remaining_seconds: remainingSeconds,
        });
      },
      onExpire: () => {
        handleSpeedTimerExpire(game.GAM_ID, game.GAM_CURRENT_QUESTION_INDEX);
      },
    });

    const { startedAt } = currentTimer.start();

    // Broadcast question_open (US-012 CA-5)
    sender.broadcast({
      type: "question_open",
      question_index: game.GAM_CURRENT_QUESTION_INDEX,
      question_type: "SPEED",
      title: question.QST_TITLE,
      started_at: startedAt,
      time_limit: question.QST_TIME_LIMIT,
    });

    return okResult();
  }

  // ── SPEED: timer expiration handling ───────────────────────────────────

  function handleSpeedTimerExpire(gameId, questionIndex) {
    // Check current game state
    const game = loadActiveGame();
    if (!game) return;

    if (game.GAM_STATUS === "QUESTION_BUZZED") {
      // CA-10: timer expires during QUESTION_BUZZED → send timer_end to admin only
      if (currentSpeedProcessor) {
        currentSpeedProcessor.setTimerExpiredDuringBuzz();
      }
      logInfo("GAME_TIMER_EXPIRED_DURING_BUZZ", {
        game_id: gameId,
        question_index: questionIndex,
        participant_order: currentSpeedProcessor?.getCurrentBuzzer()?.participantOrder,
      });
      sender.sendToAdmin({ type: "timer_end" });
      currentTimer = null;
    } else {
      // CA-9: timer expires during QUESTION_OPEN → normal expiration
      sender.broadcast({ type: "timer_end" });
      currentTimer = null;
      // Close the question with no winner
      closeSpeedQuestionNoWinner(game);
    }
  }

  // ── SPEED: close question with no winner (expiration or all invalidated) ──

  async function closeSpeedQuestionNoWinner(game) {
    // Transition to QUESTION_CLOSED
    transitionState(db, game.GAM_ID, game.GAM_STATUS, "QUESTION_CLOSED");

    logInfo("GAME_QUESTION_STATE_CHANGED", {
      game_id: game.GAM_ID,
      question_index: game.GAM_CURRENT_QUESTION_INDEX,
      new_status: "QUESTION_CLOSED",
    });

    const names = loadParticipantNames(game.GAM_ID);

    // CA-27: no persistence when no winner
    // CA-30: send question_result to each buzzer (all incorrect, 0 points)
    const results = currentSpeedProcessor.getResults();
    for (const r of results) {
      sender.sendToBuzzer(r.participantOrder, {
        type: "question_result",
        correct_answer: r.correctAnswer,
        correct: r.correct,
        points_earned: r.pointsEarned,
        cumulative_score: r.cumulativeScore,
      });
    }

    // CA-31: send question_result_summary to admin
    const summary = currentSpeedProcessor.getSummary(names);
    sender.sendToAdmin({
      type: "question_result_summary",
      ...summary,
    });

    currentSpeedProcessor = null;
    currentQuestion = null;
  }

  // ── trigger_choices (MCQ only: CA-8 to CA-12) ─────────────────────────

  function handleTriggerChoices() {
    const game = loadActiveGame();
    if (!game) return errorResult("NO_ACTIVE_GAME", "No active game found.");

    // CA-12 : état doit être QUESTION_TITLE
    if (game.GAM_STATUS !== "QUESTION_TITLE") {
      return errorResult("INVALID_STATE", "This action is not allowed in the current game state.");
    }

    const question = resolveCurrentQuestion(db, game.GAM_QUIZ_ID, game.GAM_CURRENT_QUESTION_INDEX);
    const names = loadParticipantNames(game.GAM_ID);
    const orders = Object.keys(names).map(Number);
    const cumulativeScores = loadCumulativeScores(game.GAM_ID, orders);

    // Create answer processor for this question
    currentProcessor = createAnswerProcessor({
      questionId: question.QST_ID,
      correctAnswer: mapCorrectAnswerToLetter(question),
      points: question.QST_POINTS,
      timeLimitMs: question.QST_TIME_LIMIT * 1000,
      participantOrders: orders,
      cumulativeScores,
    });

    // Transition (CA-8)
    transitionState(db, game.GAM_ID, "QUESTION_TITLE", "QUESTION_OPEN");

    // Start timer (CA-9, CA-10, CA-11)
    currentTimer = createGameTimer({
      timeLimitSeconds: question.QST_TIME_LIMIT,
      onTick: (remainingSeconds) => {
        sender.broadcast({
          type: "timer_tick",
          remaining_seconds: remainingSeconds,
        });
      },
      onExpire: () => {
        if (currentProcessor) {
          currentProcessor.expire();
        }
        sender.broadcast({ type: "timer_end" });
        currentTimer = null;
      },
    });

    const { startedAt } = currentTimer.start();

    // Broadcast question_choices (CA-9)
    sender.broadcast({
      type: "question_choices",
      choices: [question.QST_CHOICE_A, question.QST_CHOICE_B, question.QST_CHOICE_C, question.QST_CHOICE_D],
      started_at: startedAt,
      time_limit: question.QST_TIME_LIMIT,
    });

    return okResult();
  }

  // ── handleAnswer (MCQ: CA-13 to CA-21) ────────────────────────────────

  function handleAnswer(participantOrder, answer, timeMs) {
    // CA-17 : must be in QUESTION_OPEN
    const game = loadActiveGame();
    if (!game || game.GAM_STATUS !== "QUESTION_OPEN" || !currentProcessor) {
      return { accepted: false, reason: "INVALID_STATE" };
    }

    // Delegate to answer processor (CA-13, CA-18, CA-19, CA-20, CA-21)
    const result = currentProcessor.recordAnswer(participantOrder, answer, timeMs);

    if (result.accepted) {
      const names = loadParticipantNames(game.GAM_ID);

      // CA-14 : answer_received to buzzer
      sender.sendToBuzzer(participantOrder, { type: "answer_received" });

      // CA-15 : player_answered to admin
      sender.sendToAdmin({
        type: "player_answered",
        participant_order: participantOrder,
        participant_name: names[participantOrder],
        answer,
        time_ms: timeMs,
      });

      // CA-16 : all_answered
      if (currentProcessor.allAnswered()) {
        sender.sendToAdmin({ type: "all_answered" });
      }
    }

    return result;
  }

  // ── handleBuzz (SPEED: US-012 CA-13 to CA-18) ────────────────────────

  function handleBuzz(sub, username, participantOrder) {
    const game = loadActiveGame();
    if (!game) return { accepted: false, reason: "NO_ACTIVE_GAME" };

    // CA-16: buzz not in QUESTION_OPEN → ignore silently
    if (game.GAM_STATUS !== "QUESTION_OPEN" || !currentSpeedProcessor) {
      logWarn("GAME_BUZZ_IGNORED", {
        reason: "Not in QUESTION_OPEN state",
        participant_order: participantOrder,
        game_id: game.GAM_ID,
      });
      return { accepted: false, reason: "INVALID_STATE" };
    }

    // Compute time elapsed
    const timeMsAtBuzz = currentTimer ? (currentQuestion.QST_TIME_LIMIT * 1000) - currentTimer.getRemainingMs() : 0;

    const result = currentSpeedProcessor.recordBuzz(sub, username, participantOrder, timeMsAtBuzz);

    if (!result.accepted) {
      // CA-17, CA-18: log warning
      logWarn("GAME_BUZZ_IGNORED", {
        reason: result.reason === "ALREADY_INVALIDATED" ? "Already invalidated" : result.reason,
        participant_order: participantOrder,
        game_id: game.GAM_ID,
      });
      return result;
    }

    logInfo("GAME_BUZZ_RECEIVED", {
      game_id: game.GAM_ID,
      question_index: game.GAM_CURRENT_QUESTION_INDEX,
      participant_order: participantOrder,
      time_ms: timeMsAtBuzz,
    });

    // CA-11: suspend timer
    if (currentTimer) {
      currentTimer.suspend();
    }

    // Transition QUESTION_OPEN → QUESTION_BUZZED (CA-13)
    transitionState(db, game.GAM_ID, "QUESTION_OPEN", "QUESTION_BUZZED");

    logInfo("GAME_QUESTION_STATE_CHANGED", {
      game_id: game.GAM_ID,
      question_index: game.GAM_CURRENT_QUESTION_INDEX,
      new_status: "QUESTION_BUZZED",
    });

    // CA-14: send buzz_accepted to the buzzer
    sender.sendToBuzzer(participantOrder, { type: "buzz_accepted" });

    // CA-15: send buzz_locked to all other buzzers + admin
    const names = loadParticipantNames(game.GAM_ID);
    const msg = {
      type: "buzz_locked",
      buzzer_username: username,
    };

    // Send to admin
    sender.sendToAdmin(msg);
    // Send to all other buzzers
    const orders = Object.keys(names).map(Number);
    for (const order of orders) {
      if (order !== participantOrder) {
        sender.sendToBuzzer(order, msg);
      }
    }

    return { accepted: true };
  }

  // ── handleValidateAnswer (SPEED: US-012 CA-19, CA-20) ─────────────────

  async function handleValidateAnswer() {
    const game = loadActiveGame();
    if (!game) return errorResult("NO_ACTIVE_GAME", "No active game found.");

    // CA-20: must be in QUESTION_BUZZED
    if (game.GAM_STATUS !== "QUESTION_BUZZED" || !currentSpeedProcessor) {
      return errorResult("INVALID_STATE", "This action is not allowed in the current game state.");
    }

    // Stop timer
    cleanupTimer();

    // CA-19: validate the answer
    const winnerData = currentSpeedProcessor.validate();

    // Transition QUESTION_BUZZED → QUESTION_CLOSED
    transitionState(db, game.GAM_ID, "QUESTION_BUZZED", "QUESTION_CLOSED");

    logInfo("GAME_QUESTION_STATE_CHANGED", {
      game_id: game.GAM_ID,
      question_index: game.GAM_CURRENT_QUESTION_INDEX,
      new_status: "QUESTION_CLOSED",
    });

    const names = loadParticipantNames(game.GAM_ID);
    const question = currentQuestion || resolveCurrentQuestion(db, game.GAM_QUIZ_ID, game.GAM_CURRENT_QUESTION_INDEX);

    // CA-26: persist only the winner
    const now = new Date().toISOString();
    const answerData = {
      id: uuidv7(),
      gameId: game.GAM_ID,
      questionId: question.QST_ID,
      participantOrder: winnerData.participantOrder,
      answer: "SPEED_WIN",
      timeMs: winnerData.timeMsAtBuzz,
      pointsEarned: winnerData.pointsEarned,
      cumulativeScore: winnerData.cumulativeScore,
      createdAt: now,
    };

    const doInsert = persistFn
      ? () => persistFn([answerData])
      : () => insertGameAnswer(db, answerData);

    try {
      await persistWithRetry(doInsert, retryOptions);
    } catch (err) {
      // CA-29: after 3 failed attempts → IN_ERROR
      updateGameStatus(db, game.GAM_ID, "IN_ERROR");
      sender.sendToAdmin({
        type: "error",
        code: "INTERNAL_ERROR",
        message: "Failed to save scores after multiple attempts.",
      });
      currentSpeedProcessor = null;
      currentQuestion = null;
      return errorResult("INTERNAL_ERROR", "Failed to save scores after multiple attempts.");
    }

    // CA-30: send question_result to each buzzer
    const results = currentSpeedProcessor.getResults();
    for (const r of results) {
      sender.sendToBuzzer(r.participantOrder, {
        type: "question_result",
        correct_answer: r.correctAnswer,
        correct: r.correct,
        points_earned: r.pointsEarned,
        cumulative_score: r.cumulativeScore,
      });
    }

    // CA-31: send question_result_summary to admin
    const summary = currentSpeedProcessor.getSummary(names);
    sender.sendToAdmin({
      type: "question_result_summary",
      ...summary,
    });

    currentSpeedProcessor = null;
    currentQuestion = null;

    return okResult();
  }

  // ── handleInvalidateAnswer (SPEED: US-012 CA-21 to CA-25) ─────────────

  async function handleInvalidateAnswer() {
    const game = loadActiveGame();
    if (!game) return errorResult("NO_ACTIVE_GAME", "No active game found.");

    // CA-25: must be in QUESTION_BUZZED
    if (game.GAM_STATUS !== "QUESTION_BUZZED" || !currentSpeedProcessor) {
      return errorResult("INVALID_STATE", "This action is not allowed in the current game state.");
    }

    const buzzer = currentSpeedProcessor.getCurrentBuzzer();
    const invalidateResult = currentSpeedProcessor.invalidate();
    const invalidatedOrder = invalidateResult.participantOrder;

    // CA-22: send buzz_invalidated to the invalidated buzzer
    sender.sendToBuzzer(invalidatedOrder, { type: "buzz_invalidated" });

    // CA-24: no more available players OR timer expired during buzz → close question
    if (!invalidateResult.hasAvailablePlayers || currentSpeedProcessor.hasTimerExpiredDuringBuzz()) {
      cleanupTimer();

      // Close question with no winner
      await closeSpeedQuestionNoWinner(game);
      return okResult();
    }

    // CA-21: players still available → return to QUESTION_OPEN
    transitionState(db, game.GAM_ID, "QUESTION_BUZZED", "QUESTION_OPEN");

    logInfo("GAME_QUESTION_STATE_CHANGED", {
      game_id: game.GAM_ID,
      question_index: game.GAM_CURRENT_QUESTION_INDEX,
      new_status: "QUESTION_OPEN",
    });

    // CA-12: resume timer
    const remainingMs = currentTimer ? currentTimer.getRemainingMs() : 0;
    if (currentTimer) {
      currentTimer.resume();
    }

    const remainingSeconds = Math.ceil(remainingMs / 1000);

    // CA-23: send buzz_unlocked to all non-invalidated buzzers + admin
    const names = loadParticipantNames(game.GAM_ID);
    const orders = Object.keys(names).map(Number);
    const invalidatedSet = currentSpeedProcessor.getInvalidated();
    const unlockMsg = {
      type: "buzz_unlocked",
      remaining_seconds: remainingSeconds,
    };

    sender.sendToAdmin(unlockMsg);
    for (const order of orders) {
      if (!invalidatedSet.has(order)) {
        sender.sendToBuzzer(order, unlockMsg);
      }
    }

    return okResult();
  }

  // ── trigger_correction (MCQ: CA-22 to CA-28, CA-34, CA-35) ────────────

  async function handleTriggerCorrection() {
    const game = loadActiveGame();
    if (!game) return errorResult("NO_ACTIVE_GAME", "No active game found.");

    // CA-27 : état doit être QUESTION_OPEN
    if (game.GAM_STATUS !== "QUESTION_OPEN" || !currentProcessor) {
      return errorResult("INVALID_STATE", "This action is not allowed in the current game state.");
    }

    // CA-28 : timer actif et pas tous répondu → ANSWERS_PENDING
    const timerRunning = currentTimer && currentTimer.isRunning();
    if (timerRunning && !currentProcessor.allAnswered()) {
      return errorResult("ANSWERS_PENDING", "Not all players have answered and the timer is still running.");
    }

    // Stop timer if still running (CA-23)
    cleanupTimer();

    // Transition (CA-26)
    transitionState(db, game.GAM_ID, "QUESTION_OPEN", "QUESTION_CLOSED");

    const names = loadParticipantNames(game.GAM_ID);
    const results = currentProcessor.getResults();
    const ranking = currentProcessor.getRanking();
    const question = resolveCurrentQuestion(db, game.GAM_QUIZ_ID, game.GAM_CURRENT_QUESTION_INDEX);
    const correctLetter = mapCorrectAnswerToLetter(question);

    // CA-32, CA-34, CA-35 : persist with retry (3 attempts, exponential backoff)
    const now = new Date().toISOString();
    const answersData = results.map((r) => ({
      id: uuidv7(),
      gameId: game.GAM_ID,
      questionId: r.questionId,
      participantOrder: r.participantOrder,
      answer: r.answer,
      timeMs: r.timeMs,
      pointsEarned: r.pointsEarned,
      cumulativeScore: r.cumulativeScore,
      createdAt: now,
    }));

    const doInsert = persistFn
      ? () => persistFn(answersData)
      : () => insertGameAnswers(db, answersData);

    try {
      await persistWithRetry(doInsert, retryOptions);
    } catch (err) {
      // CA-35 : after 3 failed attempts → IN_ERROR
      updateGameStatus(db, game.GAM_ID, "IN_ERROR");
      sender.sendToAdmin({
        type: "error",
        code: "INTERNAL_ERROR",
        message: "Failed to save scores after multiple attempts.",
      });
      currentProcessor = null;
      return errorResult("INTERNAL_ERROR", "Failed to save scores after multiple attempts.");
    }

    // CA-24 : send question_result to each buzzer individually
    for (const r of results) {
      sender.sendToBuzzer(r.participantOrder, {
        type: "question_result",
        correct_answer: correctLetter,
        player_answer: r.answer,
        correct: r.correct,
        points_earned: r.pointsEarned,
        cumulative_score: r.cumulativeScore,
      });
    }

    // CA-25 : send question_result_summary to admin
    sender.sendToAdmin({
      type: "question_result_summary",
      correct_answer: correctLetter,
      results: results.map((r) => ({
        participant_order: r.participantOrder,
        participant_name: names[r.participantOrder],
        answer: r.answer,
        time_ms: r.timeMs,
        correct: r.correct,
        points_earned: r.pointsEarned,
        cumulative_score: r.cumulativeScore,
      })),
      ranking: ranking.map((r) => ({
        rank: r.rank,
        participant_name: names[r.participantOrder],
        cumulative_score: r.cumulativeScore,
        total_time_ms: r.totalTimeMs,
      })),
    });

    // Reset processor (question done)
    currentProcessor = null;

    return okResult();
  }

  // ── trigger_next_question (CA-29, CA-30, CA-31) ────────────────────────

  function handleTriggerNextQuestion() {
    const game = loadActiveGame();
    if (!game) return errorResult("NO_ACTIVE_GAME", "No active game found.");

    // CA-31 : état doit être QUESTION_CLOSED
    if (game.GAM_STATUS !== "QUESTION_CLOSED") {
      return errorResult("INVALID_STATE", "This action is not allowed in the current game state.");
    }

    const currentIndex = game.GAM_CURRENT_QUESTION_INDEX;

    if (hasMoreQuestions(db, game.GAM_QUIZ_ID, currentIndex)) {
      // CA-29 : questions restantes → incrémenter index + repasser en OPEN
      const newIndex = currentIndex + 1;
      updateGameQuestionIndex(db, game.GAM_ID, newIndex);
      transitionState(db, game.GAM_ID, "QUESTION_CLOSED", "OPEN");
    } else {
      // CA-30 : dernière question → COMPLETED
      transitionState(db, game.GAM_ID, "QUESTION_CLOSED", "COMPLETED");
    }

    return okResult();
  }

  // ── Utility ─────────────────────────────────────────────────────────────

  /**
   * Mappe la correct_answer textuelle vers la lettre A/B/C/D
   * en comparant avec les choix de la question.
   */
  function mapCorrectAnswerToLetter(question) {
    const choices = [question.QST_CHOICE_A, question.QST_CHOICE_B, question.QST_CHOICE_C, question.QST_CHOICE_D];
    const letters = ["A", "B", "C", "D"];
    const index = choices.findIndex(
      (c) => c && c.toLowerCase() === question.QST_CORRECT_ANSWER.toLowerCase()
    );
    return index >= 0 ? letters[index] : question.QST_CORRECT_ANSWER;
  }

  // ── recoverFromCrash ──────────────────────────────────────────────────

  /**
   * Récupère une partie interrompue par un crash serveur.
   * Si la partie était en QUESTION_TITLE, QUESTION_OPEN ou QUESTION_BUZZED
   * (question non terminée), elle est ramenée en OPEN au même index.
   *
   * @returns {boolean} true si une récupération a été effectuée
   */
  function recoverFromCrash() {
    const game = loadActiveGame();
    if (!game) return false;

    const interruptedStates = new Set(["QUESTION_TITLE", "QUESTION_OPEN", "QUESTION_BUZZED"]);
    if (!interruptedStates.has(game.GAM_STATUS)) return false;

    // Reset to OPEN — the question will be replayed from the beginning
    updateGameStatus(db, game.GAM_ID, "OPEN");
    return true;
  }

  return {
    handleTriggerTitle,
    handleTriggerChoices,
    handleTriggerCorrection,
    handleTriggerNextQuestion,
    handleAnswer,
    handleBuzz,
    handleValidateAnswer,
    handleInvalidateAnswer,
    recoverFromCrash,
  };
}
