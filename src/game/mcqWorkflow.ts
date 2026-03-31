/**
 * Workflow MCQ (US-011).
 *
 * Gère le cycle de vie d'une question à choix multiples :
 * trigger_title -> trigger_choices -> answer -> trigger_correction.
 */

import { v7 as uuidv7 } from "uuid";
import type { OrchestratorContext,
  OrchestratorResult,
  AnswerResult,
  GameRow,
  QuestionRow,
  GameAnswerData,
 } from "../types/index.ts";
import { transitionState, resolveCurrentQuestion } from "./gameworkflow.ts";
import { createGameTimer } from "./gameTimer.ts";
import { createAnswerProcessor } from "./gameAnswerProcessor.ts";
import { persistWithRetry } from "./persistWithRetry.ts";
import { insertGameAnswers } from "../repositories/gameanswerRepository.ts";
import { updateGameStatus } from "../repositories/gameRepository.ts";

interface McqWorkflow {
  handleTriggerTitle(game: GameRow, question: QuestionRow): OrchestratorResult;
  handleTriggerChoices(): OrchestratorResult;
  handleAnswer(participantOrder: number, answer: string, timeMs: number): AnswerResult;
  handleTriggerCorrection(): OrchestratorResult | Promise<OrchestratorResult>;
}

/**
 * Crée les handlers du workflow MCQ.
 */
export function createMcqWorkflow(ctx: OrchestratorContext): McqWorkflow {

  /**
   * Mappe la correct_answer textuelle vers la lettre A/B/C/D
   * en comparant avec les choix de la question.
   */
  function mapCorrectAnswerToLetter(question: QuestionRow): string {
    const choices = [question.QST_CHOICE_A, question.QST_CHOICE_B, question.QST_CHOICE_C, question.QST_CHOICE_D];
    const letters = ["A", "B", "C", "D"];
    const index = choices.findIndex(
      (c) => c && c.toLowerCase() === question.QST_CORRECT_ANSWER.toLowerCase()
    );
    return index >= 0 ? letters[index] : question.QST_CORRECT_ANSWER;
  }

  // ── trigger_title (MCQ: CA-4 to CA-7) ──────────────────────────────────

  function handleTriggerTitle(game: GameRow, question: QuestionRow): OrchestratorResult {
    // MCQ: transition OPEN -> QUESTION_TITLE (US-011 CA-4)
    transitionState(ctx.db, game.GAM_ID, "OPEN", "QUESTION_TITLE");

    // Broadcast question_title (US-011 CA-5)
    ctx.sender.broadcast({
      type: "question_title",
      question_index: game.GAM_CURRENT_QUESTION_INDEX,
      question_type: question.QST_TYPE,
      title: question.QST_TITLE,
      time_limit: question.QST_TIME_LIMIT,
    });

    return ctx.okResult();
  }

  // ── trigger_choices (CA-8 to CA-12) ────────────────────────────────────

  function handleTriggerChoices(): OrchestratorResult {
    const game = ctx.loadActiveGame();
    if (!game) return ctx.errorResult("NO_ACTIVE_GAME", "No active game found.");

    // CA-12 : état doit être QUESTION_TITLE
    if (game.GAM_STATUS !== "QUESTION_TITLE") {
      return ctx.errorResult("INVALID_STATE", "This action is not allowed in the current game state.");
    }

    const question = resolveCurrentQuestion(ctx.db, game.GAM_QUIZ_ID, game.GAM_CURRENT_QUESTION_INDEX)!;
    const names = ctx.loadParticipantNames(game.GAM_ID);
    const orders = Object.keys(names).map(Number);
    const cumulativeScores = ctx.loadCumulativeScores(game.GAM_ID, orders);

    // Create answer processor for this question
    ctx.setProcessor(createAnswerProcessor({
      questionId: question.QST_ID,
      correctAnswer: mapCorrectAnswerToLetter(question),
      points: question.QST_POINTS,
      timeLimitMs: question.QST_TIME_LIMIT * 1000,
      participantOrders: orders,
      cumulativeScores,
    }));

    // Transition (CA-8)
    transitionState(ctx.db, game.GAM_ID, "QUESTION_TITLE", "QUESTION_OPEN");

    // Start timer (CA-9, CA-10, CA-11)
    const timer = createGameTimer({
      timeLimitSeconds: question.QST_TIME_LIMIT,
      onTick: (remainingSeconds: number) => {
        ctx.sender.broadcast({
          type: "timer_tick",
          remaining_seconds: remainingSeconds,
        });
      },
      onExpire: () => {
        const processor = ctx.getProcessor();
        if (processor) {
          processor.expire();
        }
        ctx.sender.broadcast({ type: "timer_end" });
        // US-018 CA-6: play TIMER_END on all buzzers
        ctx.sender.broadcastSystemSound?.("TIMER_END");
        ctx.setTimer(null);
        ctx.setTimerInfo(null);
      },
    });

    ctx.setTimer(timer);
    const { startedAt } = timer.start();
    ctx.setTimerInfo({ startedAt, timeLimit: question.QST_TIME_LIMIT });

    // Broadcast question_choices (CA-9)
    ctx.sender.broadcast({
      type: "question_choices",
      choices: [question.QST_CHOICE_A, question.QST_CHOICE_B, question.QST_CHOICE_C, question.QST_CHOICE_D],
      started_at: startedAt,
      time_limit: question.QST_TIME_LIMIT,
    });

    return ctx.okResult();
  }

  // ── handleAnswer (CA-13 to CA-21) ──────────────────────────────────────

  function handleAnswer(participantOrder: number, answer: string, timeMs: number): AnswerResult {
    // CA-17 : must be in QUESTION_OPEN
    const game = ctx.loadActiveGame();
    const processor = ctx.getProcessor();
    if (!game || game.GAM_STATUS !== "QUESTION_OPEN" || !processor) {
      return { accepted: false, reason: "INVALID_STATE" };
    }

    // Delegate to answer processor (CA-13, CA-18, CA-19, CA-20, CA-21)
    const result = processor.recordAnswer(participantOrder, answer, timeMs);

    if (result.accepted) {
      const names = ctx.loadParticipantNames(game.GAM_ID);

      // CA-14 : answer_received to buzzer
      ctx.sender.sendToBuzzer(participantOrder, { type: "answer_received" });

      // CA-15 : player_answered to admin
      ctx.sender.sendToAdmin({
        type: "player_answered",
        participant_order: participantOrder,
        participant_name: names[participantOrder],
        choice: answer,
        response_time_ms: timeMs,
      });

      // CA-16 : all_answered
      if (processor.allAnswered()) {
        ctx.sender.sendToAdmin({ type: "all_answered" });
      }
    }

    return result;
  }

  // ── trigger_correction (CA-22 to CA-28, CA-34, CA-35) ──────────────────

  async function handleTriggerCorrection(): Promise<OrchestratorResult> {
    const game = ctx.loadActiveGame();
    if (!game) return ctx.errorResult("NO_ACTIVE_GAME", "No active game found.");

    const processor = ctx.getProcessor();

    // CA-27 : état doit être QUESTION_OPEN
    if (game.GAM_STATUS !== "QUESTION_OPEN" || !processor) {
      return ctx.errorResult("INVALID_STATE", "This action is not allowed in the current game state.");
    }

    // CA-28 : timer actif et pas tous répondu -> ANSWERS_PENDING
    const timer = ctx.getTimer();
    const timerRunning = timer && timer.isRunning();
    if (timerRunning && !processor.allAnswered()) {
      return ctx.errorResult("ANSWERS_PENDING", "Not all players have answered and the timer is still running.");
    }

    // Stop timer if still running (CA-23)
    ctx.cleanupTimer();

    // Transition (CA-26)
    transitionState(ctx.db, game.GAM_ID, "QUESTION_OPEN", "QUESTION_CLOSED");

    const names = ctx.loadParticipantNames(game.GAM_ID);
    const results = processor.getResults();
    const ranking = processor.getRanking();
    const question = resolveCurrentQuestion(ctx.db, game.GAM_QUIZ_ID, game.GAM_CURRENT_QUESTION_INDEX)!;
    const correctLetter = mapCorrectAnswerToLetter(question);

    // CA-32, CA-34, CA-35 : persist with retry (3 attempts, exponential backoff)
    const now = new Date().toISOString();
    const answersData: GameAnswerData[] = results.map((r) => ({
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

    const doInsert = ctx.persistFn
      ? () => ctx.persistFn!(answersData)
      : () => insertGameAnswers(ctx.db, answersData);

    try {
      await persistWithRetry(doInsert, ctx.retryOptions);
    } catch (err) {
      // CA-35 : after 3 failed attempts -> IN_ERROR
      updateGameStatus(ctx.db, game.GAM_ID, "IN_ERROR");
      ctx.sender.sendToAdmin({
        type: "error",
        code: "INTERNAL_ERROR",
        message: "Failed to save scores after multiple attempts.",
      });
      ctx.setProcessor(null);
      return ctx.errorResult("INTERNAL_ERROR", "Failed to save scores after multiple attempts.");
    }

    // CA-24 : send question_result to each buzzer individually
    for (const r of results) {
      ctx.sender.sendToBuzzer(r.participantOrder, {
        type: "question_result",
        correct_answer: correctLetter,
        player_answer: r.answer,
        correct: r.correct,
        points_earned: r.pointsEarned,
        cumulative_score: r.cumulativeScore,
      });
      // US-018 CA-4/CA-5: play CORRECT_ANSWER or WRONG_ANSWER
      ctx.sender.sendSystemSoundToBuzzer?.(r.participantOrder, r.correct ? "CORRECT_ANSWER" : "WRONG_ANSWER");
    }

    // CA-25 : send question_result_summary to admin
    ctx.sender.sendToAdmin({
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
    ctx.setProcessor(null);

    return ctx.okResult();
  }

  return {
    handleTriggerTitle,
    handleTriggerChoices,
    handleAnswer,
    handleTriggerCorrection,
  };
}
