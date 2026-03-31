/**
 * Processeur de réponses pour une question MCQ (CA-13 à CA-21, CA-23 à CA-25, CA-32, CA-33).
 *
 * Responsabilités :
 * - Validation des réponses (valeur, doublon, participant, expiration)
 * - Enregistrement en mémoire
 * - Détection du "tous ont répondu"
 * - Calcul des scores et classement
 *
 * Ce module est sans état global : chaque question reçoit un nouveau processeur.
 */

import { IAnswerProcessor, AnswerResult, QuestionResult, RankingEntry } from "../types/index.ts";

const VALID_ANSWERS = new Set(["A", "B", "C", "D"]);

interface AnswerProcessorOptions {
  questionId: string;
  correctAnswer: string;
  points: number;
  timeLimitMs: number;
  participantOrders: number[];
  cumulativeScores: Record<number, number>;
  connectedOrders?: Set<number> | null;
}

/**
 * Crée un processeur de réponses pour une question MCQ.
 */
export function createAnswerProcessor({
  questionId,
  correctAnswer,
  points,
  timeLimitMs,
  participantOrders,
  cumulativeScores,
  connectedOrders = null,
}: AnswerProcessorOptions): IAnswerProcessor {
  const answers = new Map<number, { answer: string; timeMs: number }>();
  let expired = false;
  const participantSet = new Set(participantOrders);

  /**
   * Enregistre une réponse (CA-13, CA-18, CA-19, CA-20, CA-21).
   */
  function recordAnswer(participantOrder: number, answer: string, timeMs: number): AnswerResult {
    // CA-20 : rejet si chrono expiré
    if (expired) {
      return { accepted: false, participantOrder, reason: "TIMER_EXPIRED" };
    }

    // CA-21 : rejet si participant inconnu
    if (!participantSet.has(participantOrder)) {
      return { accepted: false, participantOrder, reason: "UNKNOWN_PARTICIPANT" };
    }

    // CA-19 : rejet si valeur invalide
    if (!answer || !VALID_ANSWERS.has(answer)) {
      return { accepted: false, participantOrder, reason: "INVALID_ANSWER" };
    }

    // CA-18 : rejet si doublon
    if (answers.has(participantOrder)) {
      return { accepted: false, participantOrder, reason: "DUPLICATE_ANSWER" };
    }

    // CA-13 : enregistrement
    answers.set(participantOrder, { answer, timeMs });
    return { accepted: true, participantOrder, answer, timeMs };
  }

  /**
   * Vérifie si tous les participants concernés ont répondu (CA-16).
   * Si connectedOrders est fourni, seuls les participants connectés comptent.
   */
  function allAnswered(): boolean {
    const relevantOrders = connectedOrders || participantSet;
    for (const order of relevantOrders) {
      if (!answers.has(order)) return false;
    }
    return true;
  }

  /**
   * Vérifie si un participant a déjà répondu.
   */
  function hasAnswered(participantOrder: number): boolean {
    return answers.has(participantOrder);
  }

  /**
   * Marque le chrono comme expiré (CA-11, CA-20).
   */
  function expire(): void {
    expired = true;
  }

  function isExpired(): boolean {
    return expired;
  }

  /**
   * Calcule les résultats pour tous les participants (CA-23, CA-24, CA-25, CA-32, CA-33).
   *
   * Les participants n'ayant pas répondu reçoivent :
   * answer: null, timeMs: timeLimitMs, pointsEarned: 0 (CA-33).
   */
  function getResults(): QuestionResult[] {
    return participantOrders
      .slice()
      .sort((a, b) => a - b)
      .map((order) => {
        const recorded = answers.get(order);
        const answer = recorded ? recorded.answer : null;
        const timeMs = recorded ? recorded.timeMs : timeLimitMs;
        const correct = answer === correctAnswer;
        const pointsEarned = correct ? points : 0;
        const previousScore = cumulativeScores[order] ?? 0;

        return {
          questionId,
          participantOrder: order,
          answer,
          timeMs,
          correct,
          pointsEarned,
          cumulativeScore: previousScore + pointsEarned,
        };
      });
  }

  /**
   * Calcule le classement trié par score cumulé desc, puis temps total asc (CA-25).
   */
  function getRanking(): RankingEntry[] {
    const results = getResults();

    const sorted = results
      .slice()
      .sort((a, b) => {
        if (b.cumulativeScore !== a.cumulativeScore) {
          return b.cumulativeScore - a.cumulativeScore;
        }
        return a.timeMs - b.timeMs;
      });

    return sorted.map((entry, index) => ({
      rank: index + 1,
      participantOrder: entry.participantOrder,
      cumulativeScore: entry.cumulativeScore,
      totalTimeMs: entry.timeMs,
    }));
  }

  return {
    recordAnswer,
    allAnswered,
    hasAnswered,
    getResults,
    getRanking,
    expire,
    isExpired,
  };
}
