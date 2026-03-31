/**
 * Workflow SPEED (US-012).
 *
 * Gère le cycle de vie d'une question orale :
 * trigger_title -> buzz -> validate/invalidate -> correction.
 */

import { v7 as uuidv7 } from "uuid";
import type { OrchestratorContext,
  OrchestratorResult,
  BuzzResult,
  GameRow,
  QuestionRow,
  GameAnswerData,
 } from "../types/index.ts";
import { transitionState, resolveCurrentQuestion } from "./gameworkflow.ts";
import { createGameTimer } from "./gameTimer.ts";
import { createSpeedProcessor } from "./gameSpeedProcessor.ts";
import { persistWithRetry } from "./persistWithRetry.ts";
import { insertGameAnswer } from "../repositories/gameanswerRepository.ts";
import { updateGameStatus } from "../repositories/gameRepository.ts";
import { logInfo, logWarn } from "../utils/logger.ts";

interface SpeedWorkflow {
  handleTriggerTitle(game: GameRow, question: QuestionRow): OrchestratorResult;
  handleBuzz(sub: string, username: string, participantOrder: number): BuzzResult;
  handleValidateAnswer(): OrchestratorResult | Promise<OrchestratorResult>;
  handleInvalidateAnswer(): OrchestratorResult | Promise<OrchestratorResult>;
}

/**
 * Crée les handlers du workflow SPEED.
 */
export function createSpeedWorkflow(ctx: OrchestratorContext): SpeedWorkflow {

  // ── trigger_title -> QUESTION_OPEN directly (CA-4 to CA-7) ─────────────

  function handleTriggerTitle(game: GameRow, question: QuestionRow): OrchestratorResult {
    const names = ctx.loadParticipantNames(game.GAM_ID);
    const orders = Object.keys(names).map(Number);
    const cumulativeScores = ctx.loadCumulativeScores(game.GAM_ID, orders);

    // Create speed processor
    ctx.setSpeedProcessor(createSpeedProcessor({
      questionId: question.QST_ID,
      correctAnswer: question.QST_CORRECT_ANSWER,
      points: question.QST_POINTS,
      timeLimitMs: question.QST_TIME_LIMIT * 1000,
      participantOrders: orders,
      cumulativeScores,
    }));

    // Transition OPEN -> QUESTION_OPEN (skip QUESTION_TITLE)
    transitionState(ctx.db, game.GAM_ID, "OPEN", "QUESTION_OPEN");

    logInfo("GAME_QUESTION_STATE_CHANGED", {
      game_id: game.GAM_ID,
      question_index: game.GAM_CURRENT_QUESTION_INDEX,
      new_status: "QUESTION_OPEN",
    });

    // Start timer with SPEED-specific behavior
    const timer = createGameTimer({
      timeLimitSeconds: question.QST_TIME_LIMIT,
      onTick: (remainingSeconds: number) => {
        ctx.sender.broadcast({
          type: "timer_tick",
          remaining_seconds: remainingSeconds,
        });
      },
      onExpire: () => {
        handleTimerExpire(game.GAM_ID, game.GAM_CURRENT_QUESTION_INDEX);
      },
    });

    ctx.setTimer(timer);
    const { startedAt } = timer.start();
    ctx.setTimerInfo({ startedAt, timeLimit: question.QST_TIME_LIMIT });

    // Broadcast question_open (US-012 CA-5)
    ctx.sender.broadcast({
      type: "question_open",
      question_index: game.GAM_CURRENT_QUESTION_INDEX,
      question_type: "SPEED",
      title: question.QST_TITLE,
      started_at: startedAt,
      time_limit: question.QST_TIME_LIMIT,
    });

    // Send expected answer to admin only (game master needs it to compare)
    ctx.sender.sendToAdmin({
      type: "expected_answer",
      correct_answer: question.QST_CORRECT_ANSWER,
    });

    return ctx.okResult();
  }

  // ── Timer expiration handling ──────────────────────────────────────────

  function handleTimerExpire(gameId: string, questionIndex: number): void {
    const game = ctx.loadActiveGame();
    if (!game) return;

    const speedProcessor = ctx.getSpeedProcessor();

    if (game.GAM_STATUS === "QUESTION_BUZZED") {
      // CA-10: timer expires during QUESTION_BUZZED -> send timer_end to admin only
      if (speedProcessor) {
        speedProcessor.setTimerExpiredDuringBuzz();
      }
      logInfo("GAME_TIMER_EXPIRED_DURING_BUZZ", {
        game_id: gameId,
        question_index: questionIndex,
        participant_order: speedProcessor?.getCurrentBuzzer()?.participantOrder ?? null,
      });
      ctx.sender.sendToAdmin({ type: "timer_end" });
      ctx.setTimer(null);
      ctx.setTimerInfo(null);
    } else {
      // CA-9: timer expires during QUESTION_OPEN -> normal expiration
      ctx.sender.broadcast({ type: "timer_end" });
      // US-018 CA-6: play TIMER_END on all buzzers
      ctx.sender.broadcastSystemSound?.("TIMER_END");
      ctx.setTimer(null);
      ctx.setTimerInfo(null);
      // Close the question with no winner
      closeQuestionNoWinner(game);
    }
  }

  // ── Close question with no winner (expiration or all invalidated) ──────

  async function closeQuestionNoWinner(game: GameRow): Promise<void> {
    const speedProcessor = ctx.getSpeedProcessor();

    // Transition to QUESTION_CLOSED
    transitionState(ctx.db, game.GAM_ID, game.GAM_STATUS, "QUESTION_CLOSED");

    logInfo("GAME_QUESTION_STATE_CHANGED", {
      game_id: game.GAM_ID,
      question_index: game.GAM_CURRENT_QUESTION_INDEX,
      new_status: "QUESTION_CLOSED",
    });

    const names = ctx.loadParticipantNames(game.GAM_ID);

    // CA-27: no persistence when no winner
    // CA-30: send question_result to each buzzer (all incorrect, 0 points)
    const results = speedProcessor!.getResults();
    for (const r of results) {
      ctx.sender.sendToBuzzer(r.participantOrder, {
        type: "question_result",
        correct_answer: r.correctAnswer,
        correct: r.correct,
        points_earned: r.pointsEarned,
        cumulative_score: r.cumulativeScore,
      });
      // US-018 CA-4/CA-5: play CORRECT_ANSWER or WRONG_ANSWER
      ctx.sender.sendSystemSoundToBuzzer?.(r.participantOrder, r.correct ? "CORRECT_ANSWER" : "WRONG_ANSWER");
    }

    // CA-31: send question_result_summary to admin
    const summary = speedProcessor!.getSummary(names);
    ctx.sender.sendToAdmin({
      type: "question_result_summary",
      ...summary,
    });

    ctx.setSpeedProcessor(null);
    ctx.setCurrentQuestion(null);
  }

  // ── handleBuzz (CA-13 to CA-18) ────────────────────────────────────────

  function handleBuzz(sub: string, username: string, participantOrder: number): BuzzResult {
    const game = ctx.loadActiveGame();
    if (!game) return { accepted: false, reason: "NO_ACTIVE_GAME" };

    const speedProcessor = ctx.getSpeedProcessor();

    // CA-16: buzz not in QUESTION_OPEN -> ignore silently
    if (game.GAM_STATUS !== "QUESTION_OPEN" || !speedProcessor) {
      logWarn("GAME_BUZZ_IGNORED", {
        reason: "Not in QUESTION_OPEN state",
        participant_order: participantOrder,
        game_id: game.GAM_ID,
      });
      return { accepted: false, reason: "INVALID_STATE" };
    }

    // Compute time elapsed
    const timer = ctx.getTimer();
    const currentQuestion = ctx.getCurrentQuestion();
    const timeMsAtBuzz = timer ? (currentQuestion!.QST_TIME_LIMIT * 1000) - timer.getRemainingMs() : 0;

    const result = speedProcessor.recordBuzz(sub, username, participantOrder, timeMsAtBuzz);

    if (!result.accepted) {
      // CA-17, CA-18: log warning
      logWarn("GAME_BUZZ_IGNORED", {
        reason: result.reason === "ALREADY_INVALIDATED" ? "Already invalidated" : (result.reason ?? "Unknown"),
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
    if (timer) {
      timer.suspend();
    }

    // Transition QUESTION_OPEN -> QUESTION_BUZZED (CA-13)
    transitionState(ctx.db, game.GAM_ID, "QUESTION_OPEN", "QUESTION_BUZZED");

    logInfo("GAME_QUESTION_STATE_CHANGED", {
      game_id: game.GAM_ID,
      question_index: game.GAM_CURRENT_QUESTION_INDEX,
      new_status: "QUESTION_BUZZED",
    });

    // CA-14: send buzz_accepted to the buzzer
    ctx.sender.sendToBuzzer(participantOrder, { type: "buzz_accepted" });
    // US-018 CA-1: play BUZZ_PRESSED on the buzzer
    ctx.sender.sendSystemSoundToBuzzer?.(participantOrder, "BUZZ_PRESSED");

    // CA-15: send buzz_locked to all other buzzers + admin
    const names = ctx.loadParticipantNames(game.GAM_ID);
    const msg = {
      type: "buzz_locked",
      participant_name: names[participantOrder],
      participant_order: participantOrder,
    };

    // Send to admin
    ctx.sender.sendToAdmin(msg);
    // Send to all other buzzers
    const orders = Object.keys(names).map(Number);
    for (const order of orders) {
      if (order !== participantOrder) {
        ctx.sender.sendToBuzzer(order, msg);
        // US-018 CA-2: play BUZZ_LOCKED on non-buzzer buzzers
        ctx.sender.sendSystemSoundToBuzzer?.(order, "BUZZ_LOCKED");
      }
    }

    return { accepted: true };
  }

  // ── handleValidateAnswer (CA-19, CA-20) ────────────────────────────────

  async function handleValidateAnswer(): Promise<OrchestratorResult> {
    const game = ctx.loadActiveGame();
    if (!game) return ctx.errorResult("NO_ACTIVE_GAME", "No active game found.");

    const speedProcessor = ctx.getSpeedProcessor();

    // CA-20: must be in QUESTION_BUZZED
    if (game.GAM_STATUS !== "QUESTION_BUZZED" || !speedProcessor) {
      return ctx.errorResult("INVALID_STATE", "This action is not allowed in the current game state.");
    }

    // Stop timer
    ctx.cleanupTimer();

    // CA-19: validate the answer
    const winnerData = speedProcessor.validate();

    // Transition QUESTION_BUZZED -> QUESTION_CLOSED
    transitionState(ctx.db, game.GAM_ID, "QUESTION_BUZZED", "QUESTION_CLOSED");

    logInfo("GAME_QUESTION_STATE_CHANGED", {
      game_id: game.GAM_ID,
      question_index: game.GAM_CURRENT_QUESTION_INDEX,
      new_status: "QUESTION_CLOSED",
    });

    const names = ctx.loadParticipantNames(game.GAM_ID);
    const currentQuestion = ctx.getCurrentQuestion();
    const question = currentQuestion || resolveCurrentQuestion(ctx.db, game.GAM_QUIZ_ID, game.GAM_CURRENT_QUESTION_INDEX)!;

    // CA-26: persist only the winner
    const now = new Date().toISOString();
    const answerData: GameAnswerData = {
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

    const doInsert = ctx.persistFn
      ? () => ctx.persistFn!([answerData])
      : () => insertGameAnswer(ctx.db, answerData);

    try {
      await persistWithRetry(doInsert, ctx.retryOptions);
    } catch (err) {
      // CA-29: after 3 failed attempts -> IN_ERROR
      updateGameStatus(ctx.db, game.GAM_ID, "IN_ERROR");
      ctx.sender.sendToAdmin({
        type: "error",
        code: "INTERNAL_ERROR",
        message: "Failed to save scores after multiple attempts.",
      });
      ctx.setSpeedProcessor(null);
      ctx.setCurrentQuestion(null);
      return ctx.errorResult("INTERNAL_ERROR", "Failed to save scores after multiple attempts.");
    }

    // CA-30: send question_result to each buzzer
    const results = speedProcessor.getResults();
    for (const r of results) {
      ctx.sender.sendToBuzzer(r.participantOrder, {
        type: "question_result",
        correct_answer: r.correctAnswer,
        correct: r.correct,
        points_earned: r.pointsEarned,
        cumulative_score: r.cumulativeScore,
      });
      // US-018 CA-4/CA-5: play CORRECT_ANSWER or WRONG_ANSWER
      ctx.sender.sendSystemSoundToBuzzer?.(r.participantOrder, r.correct ? "CORRECT_ANSWER" : "WRONG_ANSWER");
    }

    // CA-31: send question_result_summary to admin
    const summary = speedProcessor.getSummary(names);
    ctx.sender.sendToAdmin({
      type: "question_result_summary",
      ...summary,
    });

    ctx.setSpeedProcessor(null);
    ctx.setCurrentQuestion(null);

    return ctx.okResult();
  }

  // ── handleInvalidateAnswer (CA-21 to CA-25) ────────────────────────────

  async function handleInvalidateAnswer(): Promise<OrchestratorResult> {
    const game = ctx.loadActiveGame();
    if (!game) return ctx.errorResult("NO_ACTIVE_GAME", "No active game found.");

    const speedProcessor = ctx.getSpeedProcessor();

    // CA-25: must be in QUESTION_BUZZED
    if (game.GAM_STATUS !== "QUESTION_BUZZED" || !speedProcessor) {
      return ctx.errorResult("INVALID_STATE", "This action is not allowed in the current game state.");
    }

    const invalidateResult = speedProcessor.invalidate();
    const invalidatedOrder = invalidateResult.participantOrder;

    // CA-22: send buzz_invalidated to the invalidated buzzer
    ctx.sender.sendToBuzzer(invalidatedOrder, { type: "buzz_invalidated" });
    // US-018 CA-3: play BUZZ_INVALIDATED on the invalidated buzzer
    ctx.sender.sendSystemSoundToBuzzer?.(invalidatedOrder, "BUZZ_INVALIDATED");

    // CA-24: no more available players OR timer expired during buzz -> close question
    if (!invalidateResult.hasAvailablePlayers || speedProcessor.hasTimerExpiredDuringBuzz()) {
      ctx.cleanupTimer();

      // Close question with no winner
      await closeQuestionNoWinner(game);
      return ctx.okResult();
    }

    // CA-21: players still available -> return to QUESTION_OPEN
    transitionState(ctx.db, game.GAM_ID, "QUESTION_BUZZED", "QUESTION_OPEN");

    logInfo("GAME_QUESTION_STATE_CHANGED", {
      game_id: game.GAM_ID,
      question_index: game.GAM_CURRENT_QUESTION_INDEX,
      new_status: "QUESTION_OPEN",
    });

    // CA-12: resume timer
    const timer = ctx.getTimer();
    const remainingMs = timer ? timer.getRemainingMs() : 0;
    if (timer) {
      timer.resume();
    }

    const remainingSeconds = Math.ceil(remainingMs / 1000);

    // CA-23: send buzz_unlocked to all non-invalidated buzzers + admin
    const names = ctx.loadParticipantNames(game.GAM_ID);
    const orders = Object.keys(names).map(Number);
    const invalidatedSet = speedProcessor.getInvalidated();
    const unlockMsg = {
      type: "buzz_unlocked",
      remaining_seconds: remainingSeconds,
      invalidated_participant: names[invalidatedOrder],
    };

    ctx.sender.sendToAdmin(unlockMsg);
    for (const order of orders) {
      if (!invalidatedSet.has(order)) {
        ctx.sender.sendToBuzzer(order, unlockMsg);
      }
    }

    return ctx.okResult();
  }

  return {
    handleTriggerTitle,
    handleBuzz,
    handleValidateAnswer,
    handleInvalidateAnswer,
  };
}
