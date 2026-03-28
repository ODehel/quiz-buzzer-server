/**
 * Orchestrateur du workflow MCQ et SPEED (US-011 + US-012).
 *
 * Coordonne les modules spécialisés mcqWorkflow et speedWorkflow
 * via un contexte partagé, et expose une interface unifiée pour
 * le serveur WebSocket.
 *
 * Responsabilités :
 * - Gérer l'état partagé (timer, processeurs, cache participants)
 * - Déléguer au workflow approprié selon le type de question
 * - Fournir les handlers communs (trigger_next_question, ranking)
 */

import { findActiveGame, updateGameQuestionIndex, getCumulativeScore } from "../repositories/gameanswerRepository.js";
import { findParticipantsByGameId } from "../repositories/gameRepository.js";
import { transitionState, resolveCurrentQuestion, hasMoreQuestions } from "./gameworkflow.js";
import { calculateIntermediateRanking } from "./gameRankingCalculator.js";
import { logInfo } from "../utils/logger.js";
import { createMcqWorkflow } from "./mcqWorkflow.js";
import { createSpeedWorkflow } from "./speedWorkflow.js";

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
  /** @type {ReturnType<typeof import("./gameTimer.js").createGameTimer>|null} */
  let currentTimer = null;

  /** @type {ReturnType<typeof import("./gameAnswerProcessor.js").createAnswerProcessor>|null} */
  let currentProcessor = null;

  /** @type {ReturnType<typeof import("./gameSpeedProcessor.js").createSpeedProcessor>|null} */
  let currentSpeedProcessor = null;

  /** Cached participant names by order for the current game */
  let participantNames = null;

  /** Current question being played (cached) */
  let currentQuestion = null;

  /** Timer info for reconnection sync (US-019 CA-13) */
  let timerInfo = null;

  // ── Shared context for workflows ───────────────────────────────────────

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
    timerInfo = null;
  }

  function cleanupGameState() {
    cleanupTimer();
    currentProcessor = null;
    currentSpeedProcessor = null;
    participantNames = null;
    currentQuestion = null;
  }

  /** Contexte partagé injecté dans les workflows MCQ et SPEED */
  const ctx = {
    db,
    sender,
    persistFn,
    retryOptions,
    errorResult,
    okResult,
    loadActiveGame,
    loadParticipantNames,
    loadCumulativeScores,
    cleanupTimer,
    getTimer: () => currentTimer,
    setTimer: (t) => { currentTimer = t; },
    getProcessor: () => currentProcessor,
    setProcessor: (p) => { currentProcessor = p; },
    getSpeedProcessor: () => currentSpeedProcessor,
    setSpeedProcessor: (p) => { currentSpeedProcessor = p; },
    getTimerInfo: () => timerInfo,
    setTimerInfo: (info) => { timerInfo = info; },
    getCurrentQuestion: () => currentQuestion,
    setCurrentQuestion: (q) => { currentQuestion = q; },
  };

  // ── Workflows spécialisés ──────────────────────────────────────────────

  const mcq = createMcqWorkflow(ctx);
  const speed = createSpeedWorkflow(ctx);

  // ── trigger_title (MCQ: CA-4 to CA-7; SPEED: US-012 CA-4 to CA-7) ────
  //
  // Angular sends the same message for both MCQ and SPEED, but the server
  // auto-detects the question type and delegates to the appropriate workflow.

  function handleTriggerTitle() {
    const game = loadActiveGame();
    if (!game) return errorResult("NO_ACTIVE_GAME", "No active game found.");

    if (game.GAM_STATUS !== "OPEN") {
      return errorResult("INVALID_STATE", "This action is not allowed in the current game state.");
    }

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

    // Delegate to the appropriate workflow based on question type
    if (question.QST_TYPE === "SPEED") {
      return speed.handleTriggerTitle(game, question);
    }
    return mcq.handleTriggerTitle(game, question);
  }

  // ── trigger_next_question (CA-29, CA-30, CA-31) ────────────────────────

  function handleTriggerNextQuestion() {
    const game = loadActiveGame();
    if (!game) return errorResult("NO_ACTIVE_GAME", "No active game found.");

    if (game.GAM_STATUS !== "QUESTION_CLOSED") {
      return errorResult("INVALID_STATE", "This action is not allowed in the current game state.");
    }

    const currentIndex = game.GAM_CURRENT_QUESTION_INDEX;

    if (hasMoreQuestions(db, game.GAM_QUIZ_ID, currentIndex)) {
      const newIndex = currentIndex + 1;
      updateGameQuestionIndex(db, game.GAM_ID, newIndex);
      transitionState(db, game.GAM_ID, "QUESTION_CLOSED", "OPEN");
    } else {
      transitionState(db, game.GAM_ID, "QUESTION_CLOSED", "COMPLETED");
      sender.broadcastSystemSound?.("GAME_END");
    }

    return okResult();
  }

  // ── trigger_intermediate_ranking (US-014) ──────────────────────────────

  function handleTriggerIntermediateRanking() {
    const game = loadActiveGame();
    if (!game) return errorResult("NO_ACTIVE_GAME", "No active game found.");

    const allowedStates = new Set(["OPEN", "QUESTION_TITLE", "QUESTION_OPEN", "QUESTION_BUZZED", "QUESTION_CLOSED"]);
    if (!allowedStates.has(game.GAM_STATUS)) {
      return errorResult("INVALID_STATE", "Intermediate ranking cannot be displayed in the current game state.");
    }

    const ranking = calculateIntermediateRanking(db, game.GAM_ID);

    logInfo("GAME_INTERMEDIATE_RANKING_REQUESTED", {
      game_id: game.GAM_ID,
      game_status: game.GAM_STATUS,
      ranking_size: ranking.length,
    });

    sender.broadcast({
      type: "intermediate_ranking",
      ranking,
    });

    return okResult();
  }

  // ── getTimerInfo (US-019 CA-13) ────────────────────────────────────────

  function getTimerInfo() {
    return timerInfo;
  }

  return {
    handleTriggerTitle,
    handleTriggerChoices: mcq.handleTriggerChoices,
    handleTriggerCorrection: mcq.handleTriggerCorrection,
    handleTriggerNextQuestion,
    handleAnswer: mcq.handleAnswer,
    handleBuzz: speed.handleBuzz,
    handleValidateAnswer: speed.handleValidateAnswer,
    handleInvalidateAnswer: speed.handleInvalidateAnswer,
    handleTriggerIntermediateRanking,
    getTimerInfo,
    cleanupGameState,
  };
}
