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

import Database from "better-sqlite3";
import type { GameSender,
  GameOrchestrator,
  OrchestratorResult,
  OrchestratorContext,
  IGameTimer,
  IAnswerProcessor,
  ISpeedProcessor,
  TimerInfo,
  QuestionRow,
  GameRow,
  ParticipantRow,
  GameAnswerData,
 } from "../types/index.ts";
import { findActiveGame, updateGameQuestionIndex, getCumulativeScore } from "../repositories/gameanswerRepository.ts";
import { findParticipantsByGameId } from "../repositories/gameRepository.ts";
import { transitionState, resolveCurrentQuestion, hasMoreQuestions } from "./gameworkflow.ts";
import { calculateIntermediateRanking } from "./gameRankingCalculator.ts";
import { logInfo } from "../utils/logger.ts";
import { createMcqWorkflow } from "./mcqWorkflow.ts";
import { createSpeedWorkflow } from "./speedWorkflow.ts";

interface OrchestratorOptions {
  persistFn?: (answers: GameAnswerData[]) => void;
  retryOptions?: { maxRetries?: number; baseDelayMs?: number };
}

/**
 * Crée un orchestrateur de partie MCQ + SPEED.
 */
export function createGameOrchestrator(db: Database.Database, sender: GameSender, { persistFn, retryOptions }: OrchestratorOptions = {}): GameOrchestrator {
  let currentTimer: IGameTimer | null = null;
  let currentProcessor: IAnswerProcessor | null = null;
  let currentSpeedProcessor: ISpeedProcessor | null = null;

  /** Cached participant names by order for the current game */
  let participantNames: Record<number, string> | null = null;

  /** Current question being played (cached) */
  let currentQuestion: QuestionRow | null = null;

  /** Timer info for reconnection sync (US-019 CA-13) */
  let timerInfo: TimerInfo | null = null;

  // ── Shared context for workflows ───────────────────────────────────────

  function errorResult(code: string, message: string): OrchestratorResult {
    return { ok: false, error: { code, message } };
  }

  function okResult(data?: Record<string, unknown>): OrchestratorResult {
    return { ok: true, ...data };
  }

  function loadActiveGame(): GameRow | undefined {
    return findActiveGame(db);
  }

  function loadParticipantNames(gameId: string): Record<number, string> {
    if (!participantNames) {
      const rows = findParticipantsByGameId(db, gameId) as ParticipantRow[];
      participantNames = {};
      for (const row of rows) {
        participantNames[row.GPA_ORDER] = row.GPA_NAME;
      }
    }
    return participantNames;
  }

  function loadCumulativeScores(gameId: string, orders: number[]): Record<number, number> {
    const scores: Record<number, number> = {};
    for (const order of orders) {
      scores[order] = getCumulativeScore(db, gameId, order);
    }
    return scores;
  }

  function cleanupTimer(): void {
    if (currentTimer) {
      currentTimer.stop();
      currentTimer = null;
    }
    timerInfo = null;
  }

  function cleanupGameState(): void {
    cleanupTimer();
    currentProcessor = null;
    currentSpeedProcessor = null;
    participantNames = null;
    currentQuestion = null;
  }

  /** Contexte partagé injecté dans les workflows MCQ et SPEED */
  const ctx: OrchestratorContext = {
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
    setTimer: (t: IGameTimer | null) => { currentTimer = t; },
    getProcessor: () => currentProcessor,
    setProcessor: (p: IAnswerProcessor | null) => { currentProcessor = p; },
    getSpeedProcessor: () => currentSpeedProcessor,
    setSpeedProcessor: (p: ISpeedProcessor | null) => { currentSpeedProcessor = p; },
    getTimerInfo: () => timerInfo,
    setTimerInfo: (info: TimerInfo | null) => { timerInfo = info; },
    getCurrentQuestion: () => currentQuestion,
    setCurrentQuestion: (q: QuestionRow | null) => { currentQuestion = q; },
  };

  // ── Workflows spécialisés ──────────────────────────────────────────────

  const mcq = createMcqWorkflow(ctx);
  const speed = createSpeedWorkflow(ctx);

  // ── trigger_title (MCQ: CA-4 to CA-7; SPEED: US-012 CA-4 to CA-7) ────
  //
  // Angular sends the same message for both MCQ and SPEED, but the server
  // auto-detects the question type and delegates to the appropriate workflow.

  function handleTriggerTitle(): OrchestratorResult {
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

  function handleTriggerNextQuestion(): OrchestratorResult {
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

  function handleTriggerIntermediateRanking(): OrchestratorResult {
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

  function getTimerInfo(): TimerInfo | null {
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
