import { v7 as uuidv7 } from "uuid";
import { AppError } from "../errors/AppError.js";
import {
  insertQuiz,
  insertQuizQuestions,
  findQuizById,
  findQuizByName,
  findAllQuizzes,
  getQuizQuestionIds,
  updateQuiz,
  deleteQuizQuestions,
  deleteQuiz,
  findQuizWithQuestionsById,
} from "../repositories/quizRepository.js";
import { findQuestionById } from "../repositories/questionRepository.js";
import { validateUuid, normalizeName, NAME_REGEX } from "../utils/validation.js";

export { validateUuid, normalizeName };

/**
 * Valide le nom d'un quiz (CA-3).
 *
 * @param {string} name - Nom déjà normalisé
 * @throws {AppError} 400 VALIDATION_ERROR
 */
function validateName(name) {
  if (!name || name.length < 3 || name.length > 40 || !NAME_REGEX.test(name)) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Quiz name must be between 3 and 40 characters, start with an uppercase letter, and end with a letter or digit."
    );
  }
}

/**
 * Valide la liste de question_ids (CA-5, CA-6, CA-7, CA-8).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {unknown} questionIds
 * @throws {AppError}
 */
function validateQuestionIds(db, questionIds) {
  // CA-5 : tableau d'au moins 10 éléments
  if (!Array.isArray(questionIds) || questionIds.length < 10) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "A quiz must contain at least 10 questions."
    );
  }

  // CA-6 : pas de doublons
  const unique = new Set(questionIds);
  if (unique.size !== questionIds.length) {
    throw new AppError(400, "VALIDATION_ERROR", "question_ids must not contain duplicates.");
  }

  // CA-7 & CA-8 : UUID valide + question existante
  for (const id of questionIds) {
    validateUuid(id);
    const exists = findQuestionById(db, id);
    if (!exists) {
      throw new AppError(404, "QUESTION_NOT_FOUND", `Question not found: ${id}.`);
    }
  }
}

/**
 * Mappe une ligne DB vers le format JSON création/modification.
 *
 * @param {Object} row - Ligne T_QUIZ_QUZ
 * @param {number} questionCount
 * @returns {Object}
 */
function toApiCreateFormat(row, questionCount) {
  return {
    id: row.QUZ_ID,
    name: row.QUZ_NAME,
    question_count: questionCount,
    created_at: row.QUZ_CREATED_AT,
    last_updated_at: row.QUZ_LAST_UPDATED_AT ?? null,
  };
}

/**
 * Crée un nouveau quiz (CA-1 à CA-14).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} name
 * @param {string[]} questionIds
 * @returns {Object} Quiz créé au format API
 */
export function createQuiz(db, name, questionIds) {
  const normalized = normalizeName(name);
  validateName(normalized);
  validateQuestionIds(db, questionIds);

  // CA-4 : unicité insensible à la casse
  if (findQuizByName(db, normalized)) {
    throw new AppError(409, "QUIZ_ALREADY_EXISTS", "A quiz with this name already exists.");
  }

  const id = uuidv7();
  const now = new Date().toISOString();

  // Insertion atomique quiz + questions dans une seule transaction (CA-9)
  const insert = db.transaction(() => {
    insertQuiz(db, { id, name: normalized, createdAt: now });
    insertQuizQuestions(db, id, questionIds);
  });
  insert();

  return toApiCreateFormat(
    { QUZ_ID: id, QUZ_NAME: normalized, QUZ_CREATED_AT: now, QUZ_LAST_UPDATED_AT: null },
    questionIds.length
  );
}

/**
 * Liste tous les quiz avec question_summary (CA-15 à CA-19).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string|null} nameFilter
 * @returns {Array}
 */
export function listQuizzes(db, nameFilter) {
  return findAllQuizzes(db, nameFilter || null);
}

/**
 * Récupère un quiz par son ID avec la liste complète de ses questions ordonnées.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} id - ID du quiz
 * @returns {Object} Quiz avec tous ses détails et ses question_ids
 * @throws {AppError} 400 INVALID_UUID | 404 NOT_FOUND
 */
export function getQuizById(db, id) {
  // Valider l'UUID
  validateUuid(id);

  // Récupérer le quiz avec ses questions
  const quiz = findQuizWithQuestionsById(db, id);
  if (!quiz) {
    throw new AppError(404, "NOT_FOUND", "The requested quiz was not found.");
  }

  return quiz;
}

/**
 * Modifie entièrement un quiz (CA-20 à CA-28).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} urlId - ID issu de l'URL
 * @param {string} name
 * @param {string[]} questionIds
 * @param {string|undefined} bodyId - ID optionnel dans le body
 * @returns {Object} Quiz mis à jour au format API
 */
export function updateQuizById(db, urlId, name, questionIds, bodyId) {
  // CA-27 : UUID valide dans l'URL
  validateUuid(urlId);

  // CA-25 : ID dans le body doit correspondre à l'URL
  if (bodyId !== undefined && bodyId !== urlId) {
    throw new AppError(
      400,
      "ID_MISMATCH",
      "The ID in the request body does not match the URL parameter."
    );
  }

  // CA-26 : quiz existant
  const existing = findQuizById(db, urlId);
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "The requested quiz was not found.");
  }

  // CA-22 : mêmes validations que le POST
  const normalized = normalizeName(name);
  validateName(normalized);
  validateQuestionIds(db, questionIds);

  // CA-4 sur le PUT : unicité si le nom change
  if (normalized.toLowerCase() !== existing.QUZ_NAME.toLowerCase()) {
    if (findQuizByName(db, normalized)) {
      throw new AppError(409, "QUIZ_ALREADY_EXISTS", "A quiz with this name already exists.");
    }
  }

  // CA-24 : détection d'identité — pas d'écriture inutile
  const currentIds = getQuizQuestionIds(db, urlId);
  const isIdentical =
    normalized === existing.QUZ_NAME &&
    currentIds.length === questionIds.length &&
    currentIds.every((id, i) => id === questionIds[i]);

  if (isIdentical) {
    return toApiCreateFormat(existing, questionIds.length);
  }

  // CA-23 : remplacement de la liste + mise à jour dans une seule transaction
  const now = new Date().toISOString();
  const update = db.transaction(() => {
    updateQuiz(db, urlId, normalized, now);
    deleteQuizQuestions(db, urlId);
    insertQuizQuestions(db, urlId, questionIds);
  });
  update();

  return toApiCreateFormat(
    { QUZ_ID: urlId, QUZ_NAME: normalized, QUZ_CREATED_AT: existing.QUZ_CREATED_AT, QUZ_LAST_UPDATED_AT: now },
    questionIds.length
  );
}

/**
 * Supprime un quiz (CA-29 à CA-35).
 * Note : la garde CA-31 (partie active) sera ajoutée lors de l'US de gestion des parties.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 */
export function deleteQuizById(db, id) {
  // CA-34 : UUID valide
  validateUuid(id);

  // CA-33 : quiz existant
  const existing = findQuizById(db, id);
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "The requested quiz was not found.");
  }

  // CA-31/CA-32 : Garde QUIZ_IN_USE (US-008 CA-31, activée en US-010)
  // Vérifier qu'aucune partie active ne référence ce quiz
  // Une partie est active si son statut n'est pas 'COMPLETED' ou 'IN_ERROR' (cf. US-011)
  const activeGame = db.prepare(`
    SELECT COUNT(*) as count FROM T_GAME_GAM
    WHERE GAM_QUIZ_ID = ? AND GAM_STATUS NOT IN ('COMPLETED', 'IN_ERROR')
  `).get(id);

  if (activeGame.count > 0) {
    throw new AppError(
      403,
      "QUIZ_IN_USE",
      "Cannot delete this quiz: it is referenced by an active game."
    );
  }

  // CA-30 : suppression en cascade (quiz + liaisons) dans une transaction
  // Note: On supprime d'abord les parties COMPLETED qui referent ce quiz
  // car elles ont une contrainte de clé étrangère vers le quiz.
  // Les participants et réponses seront automatiquement supprimés via ON DELETE CASCADE
  const del = db.transaction(() => {
    // Supprimer les parties COMPLETED qui référencent ce quiz
    db.prepare(`DELETE FROM T_GAME_GAM WHERE GAM_QUIZ_ID = ? AND GAM_STATUS IN ('COMPLETED', 'IN_ERROR')`).run(id);

    // Supprimer les liaisons quiz-questions
    deleteQuizQuestions(db, id);

    // Supprimer le quiz
    deleteQuiz(db, id);
  });
  del();
}