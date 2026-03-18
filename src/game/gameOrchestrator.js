/**
 * Orchestrateur du workflow MCQ (CA-4 à CA-31).
 *
 * Connecte les modules gameWorkflow, gameTimer et gameAnswerProcessor
 * pour piloter le déroulement d'une question MCQ depuis les messages WebSocket.
 *
 * Responsabilités :
 * - Résoudre la partie active
 * - Valider les préconditions d'état pour chaque action
 * - Déléguer aux modules spécialisés
 * - Émettre les messages via les callbacks broadcast/send injectées (DIP)
 */

import { findActiveGame, updateGameQuestionIndex, getCumulativeScore, insertGameAnswers } from "../repositories/gameAnswerRepository.js";
import { v7 as uuidv7 } from "uuid";
import { findParticipantsByGameId, updateGameStatus } from "../repositories/gameRepository.js";
import { transitionState, resolveCurrentQuestion, hasMoreQuestions } from "./gameWorkflow.js";
import { createGameTimer } from "./gameTimer.js";
import { createAnswerProcessor } from "./gameAnswerProcessor.js";
import { persistWithRetry } from "./persistWithRetry.js";

/**
 * Crée un orchestrateur de partie MCQ.
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

  /** Cached participant names by order for the current game */
  let participantNames = null;

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

  // ── trigger_title (CA-4, CA-5, CA-6, CA-7) ─────────────────────────────

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

    // Transition (CA-4)
    transitionState(db, game.GAM_ID, "OPEN", "QUESTION_TITLE");

    // Reset state for new question
    currentProcessor = null;
    cleanupTimer();
    participantNames = null;

    // Broadcast question_title (CA-5)
    sender.broadcast({
      type: "question_title",
      question_index: game.GAM_CURRENT_QUESTION_INDEX,
      question_type: question.QST_TYPE,
      title: question.QST_TITLE,
      time_limit: question.QST_TIME_LIMIT,
    });

    return okResult();
  }

  // ── trigger_choices (CA-8, CA-9, CA-10, CA-11, CA-12) ──────────────────

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

  // ── handleAnswer (CA-13 to CA-21) ──────────────────────────────────────

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

  // ── trigger_correction (CA-22 to CA-28, CA-34, CA-35) ──────────────────

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

  // ── recoverFromCrash (CA-36) ────────────────────────────────────────────

  /**
   * Récupère une partie interrompue par un crash serveur.
   * Si la partie était en QUESTION_TITLE ou QUESTION_OPEN (question non terminée),
   * elle est ramenée en OPEN au même index pour rejouer la question.
   *
   * @returns {boolean} true si une récupération a été effectuée
   */
  function recoverFromCrash() {
    const game = loadActiveGame();
    if (!game) return false;

    const interruptedStates = new Set(["QUESTION_TITLE", "QUESTION_OPEN"]);
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
    recoverFromCrash,
  };
}