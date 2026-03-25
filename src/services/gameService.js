import { v7 as uuidv7 } from "uuid";
import { AppError } from "../errors/AppError.js";
import {
  insertGame,
  insertParticipants,
  findGameById,
  findParticipantsByGameId,
  findAllGames,
  countActiveGames,
  updateGameStatus,
  updateGameLastUpdated,
  deleteParticipantsByGameId,
  deleteGameById,
  findParticipantByOrder,
  updateParticipantName,
} from "../repositories/gameRepository.js";
import { findAnswersByGame } from "../repositories/gameanswerRepository.js";
import { findQuizById } from "../repositories/quizRepository.js";

/** Regex de validation UUID */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Transitions de statut autorisées via PUT/PATCH.
 * Les transitions vers IN_ERROR sont réservées au serveur.
 */
const ALLOWED_TRANSITIONS = {
  PENDING: new Set(["OPEN"]),
  OPEN: new Set(["COMPLETED"]),
  COMPLETED: new Set(),
  IN_ERROR: new Set(),
};

/**
 * Valide qu'un ID est un UUID valide.
 *
 * @param {string} id
 * @throws {AppError} 400 INVALID_UUID
 */
export function validateUuid(id) {
  if (!UUID_REGEX.test(id)) {
    throw new AppError(400, "INVALID_UUID", "The provided ID is not a valid UUID.");
  }
}

/**
 * Valide un tableau de noms de participants (CA-8, CA-9, CA-9a).
 *
 * @param {unknown} participants
 * @throws {AppError} 400 VALIDATION_ERROR
 */
function validateParticipantNames(participants) {
  if (!Array.isArray(participants) || participants.length < 1 || participants.length > 10) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "participants must be an array of 1 to 10 elements."
    );
  }
  const names = new Set();
  for (const name of participants) {
    if (typeof name !== "string" || name.trim() === "" || name.length > 50) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "Each participant name must be a non-empty string of at most 50 characters."
      );
    }
    const trimmedName = name.trim();
    if (names.has(trimmedName)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Participant name "${trimmedName}" is not unique.`
      );
    }
    names.add(trimmedName);
  }
}

/**
 * Valide une transition de statut (CA-25 à CA-29).
 *
 * @param {string} currentStatus
 * @param {string} newStatus
 * @throws {AppError} 422 INVALID_TRANSITION
 */
function validateStatusTransition(currentStatus, newStatus) {
  const allowed = ALLOWED_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.has(newStatus)) {
    throw new AppError(
      422,
      "INVALID_TRANSITION",
      `Cannot transition from ${currentStatus} to ${newStatus}.`
    );
  }
}

/**
 * Mappe une ligne DB et ses participants vers le format JSON API.
 *
 * @param {{ GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT, GAM_LAST_UPDATED_AT }} row
 * @param {Array<{ GPA_ORDER: number, GPA_NAME: string }>} participants
 * @returns {Object}
 */
function toApiFormat(row, participants) {
  return {
    id: row.GAM_ID,
    quiz_id: row.GAM_QUIZ_ID,
    status: row.GAM_STATUS,
    created_at: row.GAM_CREATED_AT,
    last_updated_at: row.GAM_LAST_UPDATED_AT ?? null,
    participants: participants.map((p) => ({ order: p.GPA_ORDER, name: p.GPA_NAME })),
  };
}

/**
 * Crée une nouvelle partie (CA-1 à CA-14).
 * Retourne l'ID de la partie créée.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {unknown} quizId
 * @param {unknown} participants
 * @returns {string} ID de la partie créée
 */
export function createGame(db, quizId, participants) {
  // CA-5 : quiz_id doit être un UUID valide
  validateUuid(quizId);
  // CA-8, CA-9 : validation des participants
  validateParticipantNames(participants);

  // CA-7 : unicité de la partie active
  if (countActiveGames(db) > 0) {
    throw new AppError(
      409,
      "ACTIVE_GAME_EXISTS",
      "A game is already active. Delete it before creating a new one."
    );
  }

  // CA-6 : quiz existant
  if (!findQuizById(db, quizId)) {
    throw new AppError(404, "QUIZ_NOT_FOUND", "The requested quiz was not found.");
  }

  const id = uuidv7();
  const now = new Date().toISOString();

  // CA-10 : insertion atomique partie + participants
  db.transaction(() => {
    insertGame(db, { id, quizId, createdAt: now });
    insertParticipants(db, id, participants.map((n) => n.trim()));
  })();

  return id;
}

/**
 * Liste toutes les parties, triées par date de création décroissante (CA-15 à CA-18).
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {Array}
 */
export function listGames(db) {
  const games = findAllGames(db);
  const participantsStmt = db.prepare(
    `SELECT GPA_ORDER, GPA_NAME FROM T_GAME_PARTICIPANT_GPA
     WHERE GPA_GAME_ID = ? ORDER BY GPA_ORDER`
  );
  return games.map((row) => toApiFormat(row, participantsStmt.all(row.GAM_ID)));
}

/**
 * Retourne une partie par son ID (CA-19 à CA-21).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @returns {Object}
 */
export function getGameById(db, id) {
  validateUuid(id);
  const row = findGameById(db, id);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", "The requested game was not found.");
  }
  return toApiFormat(row, findParticipantsByGameId(db, id));
}

/**
 * Modifie entièrement une partie (CA-22 à CA-35).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @param {{ status?: string, participants?: string[], quizId?: string }} updates
 * @returns {Object} Partie mise à jour au format API
 */
export function updateGame(db, id, { status, participants, quizId: bodyQuizId }) {
  // CA-34 : UUID valide dans l'URL
  validateUuid(id);

  // CA-33 : partie existante
  const existing = findGameById(db, id);
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "The requested game was not found.");
  }

  // CA-24 : quiz_id est immuable
  if (bodyQuizId !== undefined && bodyQuizId !== existing.GAM_QUIZ_ID) {
    throw new AppError(400, "IMMUTABLE_FIELD", "quiz_id cannot be changed after creation.");
  }

  // CA-25 à CA-29 : transition de statut
  if (status !== undefined) {
    validateStatusTransition(existing.GAM_STATUS, status);
  }

  // CA-31 : validation des participants (mêmes règles que la création)
  if (participants !== undefined) {
    validateParticipantNames(participants);
  }

  // Mise à jour atomique
  const now = new Date().toISOString();
  db.transaction(() => {
    if (status !== undefined) {
      updateGameStatus(db, id, status);
    }
    if (participants !== undefined) {
      deleteParticipantsByGameId(db, id);
      insertParticipants(db, id, participants.map((n) => n.trim()));
    }
    // Mettre à jour le timestamp de modification si des changements ont été faits
    if (status !== undefined || participants !== undefined) {
      updateGameLastUpdated(db, id, now);
    }
  })();

  return toApiFormat(findGameById(db, id), findParticipantsByGameId(db, id));
}

/**
 * Modifie partiellement une partie (CA-36 à CA-46).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @param {{ status?: string, participants?: Array<{order: number, name: string}>, quizId?: string }} updates
 * @returns {Object} Partie mise à jour au format API
 */
export function patchGame(db, id, { status, participants, quizId: bodyQuizId }) {
  // CA-45 : UUID valide dans l'URL
  validateUuid(id);

  // CA-44 : partie existante
  const existing = findGameById(db, id);
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "The requested game was not found.");
  }

  // CA-41 : quiz_id est immuable
  if (bodyQuizId !== undefined && bodyQuizId !== existing.GAM_QUIZ_ID) {
    throw new AppError(400, "IMMUTABLE_FIELD", "quiz_id cannot be changed after creation.");
  }

  // CA-42 : transitions de statut
  if (status !== undefined) {
    validateStatusTransition(existing.GAM_STATUS, status);
  }

  // CA-37 à CA-40 : validation des patches de participants
  if (participants !== undefined) {
    if (!Array.isArray(participants)) {
      throw new AppError(400, "VALIDATION_ERROR", "participants must be an array.");
    }
    const newNames = new Set();
    for (const patch of participants) {
      // CA-39 : order doit être un entier entre 1 et 10
      if (
        typeof patch !== "object" ||
        patch === null ||
        !Number.isInteger(patch.order) ||
        patch.order < 1 ||
        patch.order > 10
      ) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Each participant must have an integer order between 1 and 10."
        );
      }
      // CA-40 : nom valide
      if (typeof patch.name !== "string" || patch.name.trim() === "" || patch.name.length > 50) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Each participant name must be a non-empty string of at most 50 characters."
        );
      }
      // CA-38 : order doit référencer un participant existant
      if (!findParticipantByOrder(db, id, patch.order)) {
        throw new AppError(
          404,
          "PARTICIPANT_NOT_FOUND",
          `No participant found at order ${patch.order} for this game.`
        );
      }
      // CA-9a : unicité du nom parmi les patches
      const trimmedName = patch.name.trim();
      if (newNames.has(trimmedName)) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          `Participant name "${trimmedName}" is not unique.`
        );
      }
      newNames.add(trimmedName);
    }
    // CA-9a : vérifier l'unicité avec les participants existants non modifiés
    const allParticipants = findParticipantsByGameId(db, id);
    const patchedOrders = new Set(participants.map((p) => p.order));
    for (const existing of allParticipants) {
      if (!patchedOrders.has(existing.GPA_ORDER)) {
        const existingName = existing.GPA_NAME.trim();
        if (newNames.has(existingName)) {
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            `Participant name "${existingName}" is not unique.`
          );
        }
      }
    }
  }

  // Mise à jour atomique
  const now = new Date().toISOString();
  db.transaction(() => {
    if (status !== undefined) {
      updateGameStatus(db, id, status);
    }
    if (participants !== undefined) {
      for (const patch of participants) {
        updateParticipantName(db, id, patch.order, patch.name.trim());
      }
    }
    // Mettre à jour le timestamp de modification si des changements ont été faits
    if (status !== undefined || participants !== undefined) {
      updateGameLastUpdated(db, id, now);
    }
  })();

  return toApiFormat(findGameById(db, id), findParticipantsByGameId(db, id));
}

/**
 * Supprime une partie (CA-47 à CA-51).
 * La suppression en cascade est gérée par la contrainte FK ON DELETE CASCADE.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 */
export function deleteGame(db, id) {
  // CA-50 : UUID valide
  validateUuid(id);

  // CA-49 : partie existante
  if (!findGameById(db, id)) {
    throw new AppError(404, "NOT_FOUND", "The requested game was not found.");
  }

  deleteGameById(db, id);
}

/**
 * Retourne les résultats finaux d'une partie terminée (COMPLETED).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @returns {Object} Résultats avec classement final
 */
export function getGameResults(db, id) {
  validateUuid(id);

  const row = findGameById(db, id);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", "The requested game was not found.");
  }

  if (row.GAM_STATUS !== "COMPLETED") {
    throw new AppError(
      409,
      "GAME_NOT_COMPLETED",
      "Results are only available for completed games."
    );
  }

  const participants = findParticipantsByGameId(db, id);
  const answers = findAnswersByGame(db, id);

  // Build per-participant final scores and cumulative time
  const scoreMap = new Map();
  const timeMap = new Map();
  for (const a of answers) {
    scoreMap.set(a.GAA_PARTICIPANT_ORDER, a.GAA_CUMULATIVE_SCORE);
    timeMap.set(a.GAA_PARTICIPANT_ORDER, (timeMap.get(a.GAA_PARTICIPANT_ORDER) ?? 0) + a.GAA_TIME_MS);
  }

  // Build ranking sorted by score descending, then by total time ascending
  const ranking = participants
    .map((p) => ({
      order: p.GPA_ORDER,
      name: p.GPA_NAME,
      score: scoreMap.get(p.GPA_ORDER) ?? 0,
      total_time_ms: timeMap.get(p.GPA_ORDER) ?? 0,
    }))
    .sort((a, b) => b.score - a.score || a.total_time_ms - b.total_time_ms)
    .map((entry, index) => ({ rank: index + 1, ...entry }));

  // Build per-question details
  const questionMap = new Map();
  for (const a of answers) {
    if (!questionMap.has(a.GAA_QUESTION_ID)) {
      questionMap.set(a.GAA_QUESTION_ID, []);
    }
    questionMap.get(a.GAA_QUESTION_ID).push({
      participant_order: a.GAA_PARTICIPANT_ORDER,
      answer: a.GAA_ANSWER,
      time_ms: a.GAA_TIME_MS,
      points_earned: a.GAA_POINTS_EARNED,
      cumulative_score: a.GAA_CUMULATIVE_SCORE,
    });
  }

  const questions = [];
  for (const [questionId, questionAnswers] of questionMap) {
    questions.push({
      question_id: questionId,
      answers: questionAnswers,
    });
  }

  return {
    game_id: row.GAM_ID,
    quiz_id: row.GAM_QUIZ_ID,
    status: row.GAM_STATUS,
    ranking,
    questions,
  };
}
