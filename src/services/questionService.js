import { v7 as uuidv7 } from "uuid";
import { AppError } from "../errors/AppError.js";
import { findById as findThemeById } from "../repositories/themeRepository.js";
import {
  insertQuestion,
  insertQuestions,
  findQuestionById,
  findQuestionByTitle,
  findQuestions,
  updateQuestion,
  deleteQuestion,
} from "../repositories/questionRepository.js";
import { deleteMediaFile } from "./mediaService.js";

/** Regex de validation UUID */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Champs autorisés selon la méthode */
const ALLOWED_FIELDS_POST = new Set([
  "type", "theme_id", "title", "choices", "correct_answer",
  "level", "time_limit", "points",
]);
const ALLOWED_FIELDS_PUT = new Set([
  "id", "type", "theme_id", "title", "choices", "correct_answer",
  "level", "time_limit", "points",
]);
const ALLOWED_FIELDS_PATCH = new Set([
  "theme_id", "title", "choices", "correct_answer",
  "level", "time_limit", "points", "image_path", "audio_path",
]);

/**
 * Valide le format d'un UUID.
 * @param {string} id
 * @throws {AppError} 400 INVALID_UUID
 */
export function validateUuid(id) {
  if (!UUID_REGEX.test(id)) {
    throw new AppError(400, "INVALID_UUID", "The provided ID is not a valid UUID.");
  }
}

/**
 * Normalise un titre : trim + collapse des espaces multiples.
 * @param {string} title
 * @returns {string}
 */
export function normalizeTitle(title) {
  return title.trim().replace(/\s+/g, " ");
}

/**
 * Valide le format et la longueur du titre (CA-4).
 * @param {string} title - Titre déjà normalisé
 * @throws {AppError} 400 VALIDATION_ERROR
 */
function validateTitle(title) {
  if (title.length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "Question title is required.");
  }
  if (title.length < 10) {
    throw new AppError(400, "VALIDATION_ERROR", "Question title must be at least 10 characters long.");
  }
  if (title.length > 250) {
    throw new AppError(400, "VALIDATION_ERROR", "Question title must not exceed 250 characters.");
  }
  if (!/^\p{Lu}/u.test(title)) {
    throw new AppError(400, "VALIDATION_ERROR", "Question title must start with an uppercase letter.");
  }
}

/**
 * Valide et normalise les choices pour une question MCQ (CA-9).
 * @param {unknown} choices
 * @returns {string[]} Tableau de 4 choix normalisés
 * @throws {AppError} 400 VALIDATION_ERROR
 */
function validateChoices(choices) {
  if (!Array.isArray(choices) || choices.length !== 4) {
    throw new AppError(400, "VALIDATION_ERROR", "MCQ questions must have exactly 4 choices.");
  }
  const normalized = choices.map((c, i) => {
    if (typeof c !== "string") {
      throw new AppError(400, "VALIDATION_ERROR", `Choice ${i + 1} must be a string.`);
    }
    const trimmed = c.trim();
    if (trimmed.length === 0 || trimmed.length > 100) {
      throw new AppError(400, "VALIDATION_ERROR", `Choice ${i + 1} must be between 1 and 100 characters.`);
    }
    return trimmed;
  });

  // Unicité des choix (insensible à la casse)
  const lower = normalized.map((c) => c.toLowerCase());
  const unique = new Set(lower);
  if (unique.size !== 4) {
    throw new AppError(400, "VALIDATION_ERROR", "All 4 choices must be distinct (case-insensitive).");
  }

  return normalized;
}

/**
 * Valide le correct_answer.
 * - CA-10 (MCQ) : doit correspondre à l'un des 4 choix (insensible à la casse).
 * - CA-12 (SPEED) : chaîne non vide, 1–100 caractères.
 * @param {unknown} correctAnswer
 * @param {string[]|null} choices - Tableau des 4 choix pour MCQ, null pour SPEED
 * @returns {string} correct_answer normalisé (trimmed)
 * @throws {AppError} 400 VALIDATION_ERROR
 */
function validateCorrectAnswer(correctAnswer, choices) {
  if (typeof correctAnswer !== "string") {
    throw new AppError(400, "VALIDATION_ERROR", "correct_answer is required.");
  }
  const trimmed = correctAnswer.trim();
  if (trimmed.length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "correct_answer must not be empty.");
  }
  if (trimmed.length > 100) {
    throw new AppError(400, "VALIDATION_ERROR", "correct_answer must not exceed 100 characters.");
  }

  if (choices !== null) {
    // MCQ: must match one of the choices (case-insensitive)
    const match = choices.find((c) => c.toLowerCase() === trimmed.toLowerCase());
    if (!match) {
      throw new AppError(400, "VALIDATION_ERROR", "correct_answer must match one of the provided choices.");
    }
  }

  return trimmed;
}

/**
 * Valide un entier dans une plage donnée.
 * @param {unknown} value
 * @param {string} fieldName
 * @param {number} min
 * @param {number} max
 * @returns {number}
 * @throws {AppError} 400 VALIDATION_ERROR
 */
function validateIntRange(value, fieldName, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `${fieldName} must be an integer between ${min} and ${max}.`
    );
  }
  return value;
}

/**
 * Mappe une ligne DB vers le format JSON de l'API.
 * Pour une question SPEED, le champ choices est absent.
 * @param {Object} row
 * @returns {Object}
 */
export function toApiFormat(row) {
  const result = {
    id: row.QST_ID,
    type: row.QST_TYPE,
    theme_id: row.QST_THEME_ID,
    title: row.QST_TITLE,
  };

  if (row.QST_TYPE === "MCQ") {
    result.choices = [row.QST_CHOICE_A, row.QST_CHOICE_B, row.QST_CHOICE_C, row.QST_CHOICE_D];
  }

  result.correct_answer = row.QST_CORRECT_ANSWER;
  result.level = row.QST_LEVEL;
  result.time_limit = row.QST_TIME_LIMIT;
  result.points = row.QST_POINTS;
  result.image_path = row.QST_IMAGE_PATH ?? null;
  result.audio_path = row.QST_AUDIO_PATH ?? null;
  result.created_at = row.QST_CREATED_AT;
  result.last_updated_at = row.QST_LAST_UPDATED_AT ?? null;

  return result;
}

/**
 * Vérifie les champs inconnus dans le body.
 * @param {Object} body
 * @param {Set<string>} allowedFields
 * @throws {AppError} 400 UNKNOWN_FIELDS
 */
function checkUnknownFields(body, allowedFields) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, "INVALID_JSON", "Request body must be a JSON object.");
  }
  const unknownFields = Object.keys(body).filter((k) => !allowedFields.has(k));
  if (unknownFields.length > 0) {
    throw new AppError(400, "UNKNOWN_FIELDS", `Unknown field(s): ${unknownFields.join(", ")}.`);
  }
}

/**
 * Valide les paramètres de pagination.
 * @param {URL} url
 * @returns {{ page: number, limit: number }}
 * @throws {AppError} 400 INVALID_PAGINATION
 */
export function parsePagination(url) {
  const rawPage = url.searchParams.get("page");
  const rawLimit = url.searchParams.get("limit");

  const page = rawPage !== null ? Number(rawPage) : 1;
  const limit = rawLimit !== null ? Number(rawLimit) : 20;

  if (!Number.isInteger(page) || page < 1 ||
      !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError(400, "INVALID_PAGINATION", "Invalid pagination parameters.");
  }

  return { page, limit };
}

/**
 * Valide et extrait les paramètres de filtrage de la query string.
 * @param {URL} url
 * @param {import("better-sqlite3").Database} db
 * @returns {Object} filters
 * @throws {AppError} 400 INVALID_FILTER
 */
export function parseFilters(url, db) {
  const filters = {};

  const rawThemeId = url.searchParams.get("theme_id");
  const rawType = url.searchParams.get("type");
  const rawLevel = url.searchParams.get("level");
  const rawLevelMin = url.searchParams.get("level_min");
  const rawLevelMax = url.searchParams.get("level_max");
  const rawTimeLimitMin = url.searchParams.get("time_limit_min");
  const rawTimeLimitMax = url.searchParams.get("time_limit_max");
  const rawPointsMin = url.searchParams.get("points_min");
  const rawPointsMax = url.searchParams.get("points_max");

  // theme_id filter
  if (rawThemeId !== null) {
    if (!UUID_REGEX.test(rawThemeId)) {
      throw new AppError(400, "INVALID_FILTER", "Invalid filter parameters.");
    }
    const theme = findThemeById(db, rawThemeId);
    if (!theme) {
      throw new AppError(400, "INVALID_FILTER", "Invalid filter parameters.");
    }
    filters.theme_id = rawThemeId;
  }

  // type filter
  if (rawType !== null) {
    if (rawType !== "MCQ" && rawType !== "SPEED") {
      throw new AppError(400, "INVALID_FILTER", "Invalid filter parameters.");
    }
    filters.type = rawType;
  }

  // level filter (exact vs range - mutually exclusive, CA-44)
  if (rawLevel !== null && (rawLevelMin !== null || rawLevelMax !== null)) {
    throw new AppError(400, "INVALID_FILTER", "Invalid filter parameters.");
  }

  if (rawLevel !== null) {
    const level = Number(rawLevel);
    if (!Number.isInteger(level) || level < 1 || level > 5) {
      throw new AppError(400, "INVALID_FILTER", "Invalid filter parameters.");
    }
    filters.level = level;
  }

  if (rawLevelMin !== null) {
    const levelMin = Number(rawLevelMin);
    if (!Number.isInteger(levelMin) || levelMin < 1 || levelMin > 5) {
      throw new AppError(400, "INVALID_FILTER", "Invalid filter parameters.");
    }
    filters.level_min = levelMin;
  }

  if (rawLevelMax !== null) {
    const levelMax = Number(rawLevelMax);
    if (!Number.isInteger(levelMax) || levelMax < 1 || levelMax > 5) {
      throw new AppError(400, "INVALID_FILTER", "Invalid filter parameters.");
    }
    filters.level_max = levelMax;
  }

  if (filters.level_min !== undefined && filters.level_max !== undefined &&
      filters.level_min > filters.level_max) {
    throw new AppError(400, "INVALID_FILTER", "Invalid filter parameters.");
  }

  // time_limit filters
  if (rawTimeLimitMin !== null) {
    const v = Number(rawTimeLimitMin);
    if (!Number.isInteger(v) || v < 5 || v > 60) {
      throw new AppError(400, "INVALID_FILTER", "Invalid filter parameters.");
    }
    filters.time_limit_min = v;
  }

  if (rawTimeLimitMax !== null) {
    const v = Number(rawTimeLimitMax);
    if (!Number.isInteger(v) || v < 5 || v > 60) {
      throw new AppError(400, "INVALID_FILTER", "Invalid filter parameters.");
    }
    filters.time_limit_max = v;
  }

  if (filters.time_limit_min !== undefined && filters.time_limit_max !== undefined &&
      filters.time_limit_min > filters.time_limit_max) {
    throw new AppError(400, "INVALID_FILTER", "Invalid filter parameters.");
  }

  // points filters
  if (rawPointsMin !== null) {
    const v = Number(rawPointsMin);
    if (!Number.isInteger(v) || v < 1 || v > 50) {
      throw new AppError(400, "INVALID_FILTER", "Invalid filter parameters.");
    }
    filters.points_min = v;
  }

  if (rawPointsMax !== null) {
    const v = Number(rawPointsMax);
    if (!Number.isInteger(v) || v < 1 || v > 50) {
      throw new AppError(400, "INVALID_FILTER", "Invalid filter parameters.");
    }
    filters.points_max = v;
  }

  if (filters.points_min !== undefined && filters.points_max !== undefined &&
      filters.points_min > filters.points_max) {
    throw new AppError(400, "INVALID_FILTER", "Invalid filter parameters.");
  }

  return filters;
}

/**
 * Crée une nouvelle question (CA-1 à CA-20).
 * @param {import("better-sqlite3").Database} db
 * @param {Object} body
 * @returns {Object} Question créée au format API
 */
export function createQuestion(db, body) {
  checkUnknownFields(body, ALLOWED_FIELDS_POST);

  // Validate type (CA-6)
  const { type } = body;
  if (type !== "MCQ" && type !== "SPEED") {
    throw new AppError(400, "VALIDATION_ERROR", "Question type must be 'MCQ' or 'SPEED'.");
  }

  // CA-11: choices must be absent for SPEED
  if (type === "SPEED" && "choices" in body) {
    throw new AppError(400, "VALIDATION_ERROR", "SPEED questions must not include choices.");
  }

  // Validate theme_id (CA-7, CA-8)
  const { theme_id } = body;
  if (theme_id === undefined || theme_id === null) {
    throw new AppError(400, "VALIDATION_ERROR", "theme_id is required.");
  }
  if (typeof theme_id !== "string" || !UUID_REGEX.test(theme_id)) {
    throw new AppError(400, "INVALID_UUID", "The provided ID is not a valid UUID.");
  }
  const theme = findThemeById(db, theme_id);
  if (!theme) {
    throw new AppError(400, "INVALID_THEME", "The provided theme_id does not reference an existing theme.");
  }

  // Validate title (CA-3, CA-4, CA-5)
  if (body.title === undefined || body.title === null) {
    throw new AppError(400, "VALIDATION_ERROR", "Question title is required.");
  }
  const title = normalizeTitle(String(body.title));
  validateTitle(title);

  const existingTitle = findQuestionByTitle(db, title);
  if (existingTitle) {
    throw new AppError(409, "QUESTION_ALREADY_EXISTS", "A question with this title already exists.");
  }

  // Validate choices (MCQ only — CA-9)
  let choices = null;
  if (type === "MCQ") {
    if (body.choices === undefined) {
      throw new AppError(400, "VALIDATION_ERROR", "MCQ questions must include choices.");
    }
    choices = validateChoices(body.choices);
  }

  // Validate correct_answer (CA-10, CA-12)
  if (body.correct_answer === undefined || body.correct_answer === null) {
    throw new AppError(400, "VALIDATION_ERROR", "correct_answer is required.");
  }
  const correctAnswer = validateCorrectAnswer(body.correct_answer, choices);

  // Validate level, time_limit, points (CA-13, CA-14, CA-15)
  if (body.level === undefined || body.level === null) {
    throw new AppError(400, "VALIDATION_ERROR", "level is required.");
  }
  const level = validateIntRange(body.level, "level", 1, 5);

  if (body.time_limit === undefined || body.time_limit === null) {
    throw new AppError(400, "VALIDATION_ERROR", "time_limit is required.");
  }
  const timeLimit = validateIntRange(body.time_limit, "time_limit", 5, 60);

  if (body.points === undefined || body.points === null) {
    throw new AppError(400, "VALIDATION_ERROR", "points is required.");
  }
  const points = validateIntRange(body.points, "points", 1, 50);

  // Generate ID + timestamp (CA-16, CA-17)
  const now = new Date().toISOString();
  const id = uuidv7();

  insertQuestion(db, {
    id, type, themeId: theme_id, title,
    choiceA: choices ? choices[0] : null,
    choiceB: choices ? choices[1] : null,
    choiceC: choices ? choices[2] : null,
    choiceD: choices ? choices[3] : null,
    correctAnswer, level, timeLimit, points, createdAt: now,
  });

  return toApiFormat({
    QST_ID: id, QST_TYPE: type, QST_THEME_ID: theme_id, QST_TITLE: title,
    QST_CHOICE_A: choices ? choices[0] : null,
    QST_CHOICE_B: choices ? choices[1] : null,
    QST_CHOICE_C: choices ? choices[2] : null,
    QST_CHOICE_D: choices ? choices[3] : null,
    QST_CORRECT_ANSWER: correctAnswer, QST_LEVEL: level,
    QST_TIME_LIMIT: timeLimit, QST_POINTS: points,
    QST_IMAGE_PATH: null, QST_AUDIO_PATH: null,
    QST_CREATED_AT: now, QST_LAST_UPDATED_AT: null,
  });
}

/**
 * Crée plusieurs questions en une seule opération atomique (bulk insert).
 * @param {import("better-sqlite3").Database} db
 * @param {Object} body - Doit contenir une clé `questions` (tableau)
 * @returns {{ created_count: number, questions: Object[] }}
 */
export function createQuestions(db, body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, "VALIDATION_ERROR", "Request body must be a JSON object.");
  }

  if (!("questions" in body)) {
    throw new AppError(400, "VALIDATION_ERROR", "Body must contain a 'questions' array.");
  }

  const { questions } = body;

  if (!Array.isArray(questions)) {
    throw new AppError(400, "VALIDATION_ERROR", "'questions' must be an array.");
  }

  if (questions.length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "'questions' array must not be empty.");
  }

  if (questions.length > 50) {
    throw new AppError(400, "VALIDATION_ERROR", "'questions' array must not exceed 50 elements.");
  }

  // Detect duplicate titles within the batch (case-insensitive)
  const batchTitlesLower = new Map(); // normalizedLower -> index
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (q !== null && typeof q === "object" && !Array.isArray(q) && typeof q.title === "string") {
      const normalized = normalizeTitle(String(q.title));
      const lower = normalized.toLowerCase();
      if (batchTitlesLower.has(lower)) {
        throw new AppError(409, "QUESTION_ALREADY_EXISTS",
          `[index ${i}] A question with this title already exists (duplicate of index ${batchTitlesLower.get(lower)} in this batch).`);
      }
      batchTitlesLower.set(lower, i);
    }
  }

  // Validate each question individually and prepare DB records
  const now = new Date().toISOString();
  const records = [];
  const apiResults = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const prefix = `[index ${i}] `;

    // Must be a plain object
    if (q === null || typeof q !== "object" || Array.isArray(q)) {
      throw new AppError(400, "VALIDATION_ERROR", `${prefix}Each question must be a JSON object.`);
    }

    // Unknown fields
    const unknownFields = Object.keys(q).filter((k) => !ALLOWED_FIELDS_POST.has(k));
    if (unknownFields.length > 0) {
      throw new AppError(400, "UNKNOWN_FIELDS", `${prefix}Unknown field(s): ${unknownFields.join(", ")}.`);
    }

    // Validate type
    const { type } = q;
    if (type !== "MCQ" && type !== "SPEED") {
      throw new AppError(400, "VALIDATION_ERROR", `${prefix}Question type must be 'MCQ' or 'SPEED'.`);
    }

    // SPEED must not include choices
    if (type === "SPEED" && "choices" in q) {
      throw new AppError(400, "VALIDATION_ERROR", `${prefix}SPEED questions must not include choices.`);
    }

    // Validate theme_id
    const { theme_id } = q;
    if (theme_id === undefined || theme_id === null) {
      throw new AppError(400, "VALIDATION_ERROR", `${prefix}theme_id is required.`);
    }
    if (typeof theme_id !== "string" || !UUID_REGEX.test(theme_id)) {
      throw new AppError(400, "INVALID_UUID", `${prefix}The provided ID is not a valid UUID.`);
    }
    const theme = findThemeById(db, theme_id);
    if (!theme) {
      throw new AppError(400, "INVALID_THEME", `${prefix}The provided theme_id does not reference an existing theme.`);
    }

    // Validate title
    if (q.title === undefined || q.title === null) {
      throw new AppError(400, "VALIDATION_ERROR", `${prefix}Question title is required.`);
    }
    const title = normalizeTitle(String(q.title));
    try {
      validateTitle(title);
    } catch (err) {
      if (err instanceof AppError) {
        throw new AppError(err.status, err.error, `${prefix}${err.message}`);
      }
      throw err;
    }

    // Check for duplicate title in DB
    const existingTitle = findQuestionByTitle(db, title);
    if (existingTitle) {
      throw new AppError(409, "QUESTION_ALREADY_EXISTS",
        `${prefix}A question with this title already exists.`);
    }

    // Validate choices (MCQ only)
    let choices = null;
    if (type === "MCQ") {
      if (q.choices === undefined) {
        throw new AppError(400, "VALIDATION_ERROR", `${prefix}MCQ questions must include choices.`);
      }
      try {
        choices = validateChoices(q.choices);
      } catch (err) {
        if (err instanceof AppError) {
          throw new AppError(err.status, err.error, `${prefix}${err.message}`);
        }
        throw err;
      }
    }

    // Validate correct_answer
    if (q.correct_answer === undefined || q.correct_answer === null) {
      throw new AppError(400, "VALIDATION_ERROR", `${prefix}correct_answer is required.`);
    }
    let correctAnswer;
    try {
      correctAnswer = validateCorrectAnswer(q.correct_answer, choices);
    } catch (err) {
      if (err instanceof AppError) {
        throw new AppError(err.status, err.error, `${prefix}${err.message}`);
      }
      throw err;
    }

    // Validate level, time_limit, points
    if (q.level === undefined || q.level === null) {
      throw new AppError(400, "VALIDATION_ERROR", `${prefix}level is required.`);
    }
    let level;
    try {
      level = validateIntRange(q.level, "level", 1, 5);
    } catch (err) {
      if (err instanceof AppError) {
        throw new AppError(err.status, err.error, `${prefix}${err.message}`);
      }
      throw err;
    }

    if (q.time_limit === undefined || q.time_limit === null) {
      throw new AppError(400, "VALIDATION_ERROR", `${prefix}time_limit is required.`);
    }
    let timeLimit;
    try {
      timeLimit = validateIntRange(q.time_limit, "time_limit", 5, 60);
    } catch (err) {
      if (err instanceof AppError) {
        throw new AppError(err.status, err.error, `${prefix}${err.message}`);
      }
      throw err;
    }

    if (q.points === undefined || q.points === null) {
      throw new AppError(400, "VALIDATION_ERROR", `${prefix}points is required.`);
    }
    let points;
    try {
      points = validateIntRange(q.points, "points", 1, 50);
    } catch (err) {
      if (err instanceof AppError) {
        throw new AppError(err.status, err.error, `${prefix}${err.message}`);
      }
      throw err;
    }

    const id = uuidv7();
    records.push({
      id, type, themeId: theme_id, title,
      choiceA: choices ? choices[0] : null,
      choiceB: choices ? choices[1] : null,
      choiceC: choices ? choices[2] : null,
      choiceD: choices ? choices[3] : null,
      correctAnswer, level, timeLimit, points, createdAt: now,
    });

    apiResults.push(toApiFormat({
      QST_ID: id, QST_TYPE: type, QST_THEME_ID: theme_id, QST_TITLE: title,
      QST_CHOICE_A: choices ? choices[0] : null,
      QST_CHOICE_B: choices ? choices[1] : null,
      QST_CHOICE_C: choices ? choices[2] : null,
      QST_CHOICE_D: choices ? choices[3] : null,
      QST_CORRECT_ANSWER: correctAnswer, QST_LEVEL: level,
      QST_TIME_LIMIT: timeLimit, QST_POINTS: points,
      QST_IMAGE_PATH: null, QST_AUDIO_PATH: null,
      QST_CREATED_AT: now, QST_LAST_UPDATED_AT: null,
    }));
  }

  insertQuestions(db, records);

  return {
    created_count: records.length,
    questions: apiResults,
  };
}

/**
 * Récupère une question par ID (CA-21 à CA-25).
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @returns {Object}
 */
export function getQuestion(db, id) {
  validateUuid(id);
  const row = findQuestionById(db, id);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", "The requested question was not found.");
  }
  return toApiFormat(row);
}

/**
 * Liste les questions avec pagination et filtrage (CA-26 à CA-44).
 * @param {import("better-sqlite3").Database} db
 * @param {Object} filters
 * @param {number} page
 * @param {number} limit
 * @returns {Object}
 */
export function listQuestions(db, filters, page, limit) {
  const { data, total } = findQuestions(db, filters, page, limit);
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

  return {
    data: data.map(toApiFormat),
    page, limit, total, total_pages: totalPages,
  };
}

/**
 * Détecte si deux états de question sont identiques (pour éviter une mise à jour inutile).
 * - Champs texte non-nuls (themeId, title, correctAnswer, choices) : comparaison insensible à la casse.
 * - Champs entiers (level, timeLimit, points) : égalité stricte.
 * - Champs optionnels (imagePath, audioPath) : égalité stricte avec gestion explicite de null.
 */
function isIdentical(row, fields) {
  const lowerOf = (s) => (s ?? "").toLowerCase();
  if (fields.themeId !== undefined && lowerOf(row.QST_THEME_ID) !== lowerOf(fields.themeId)) return false;
  if (fields.title !== undefined && lowerOf(row.QST_TITLE) !== lowerOf(fields.title)) return false;
  if (fields.correctAnswer !== undefined && lowerOf(row.QST_CORRECT_ANSWER) !== lowerOf(fields.correctAnswer)) return false;
  if (fields.level !== undefined && row.QST_LEVEL !== fields.level) return false;
  if (fields.timeLimit !== undefined && row.QST_TIME_LIMIT !== fields.timeLimit) return false;
  if (fields.points !== undefined && row.QST_POINTS !== fields.points) return false;
  if (fields.choiceA !== undefined && lowerOf(row.QST_CHOICE_A) !== lowerOf(fields.choiceA)) return false;
  if (fields.choiceB !== undefined && lowerOf(row.QST_CHOICE_B) !== lowerOf(fields.choiceB)) return false;
  if (fields.choiceC !== undefined && lowerOf(row.QST_CHOICE_C) !== lowerOf(fields.choiceC)) return false;
  if (fields.choiceD !== undefined && lowerOf(row.QST_CHOICE_D) !== lowerOf(fields.choiceD)) return false;
  // Optional path fields: null must compare equal to null (not masked by string conversion)
  if (fields.imagePath !== undefined) {
    const stored = row.QST_IMAGE_PATH ?? null;
    if (stored !== fields.imagePath) return false;
  }
  if (fields.audioPath !== undefined) {
    const stored = row.QST_AUDIO_PATH ?? null;
    if (stored !== fields.audioPath) return false;
  }
  return true;
}

/**
 * Met à jour entièrement une question (PUT — CA-45 à CA-55).
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @param {Object} body
 * @returns {Object}
 */
export function updateQuestionById(db, id, body) {
  validateUuid(id);

  const existing = findQuestionById(db, id);
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "The requested question was not found.");
  }

  checkUnknownFields(body, ALLOWED_FIELDS_PUT);

  // CA-50: ID mismatch
  if (body.id !== undefined && body.id !== id) {
    throw new AppError(400, "ID_MISMATCH", "The ID in the request body does not match the URL parameter.");
  }

  // CA-48: type must match current
  const { type } = body;
  if (type === undefined || type === null) {
    throw new AppError(400, "VALIDATION_ERROR", "type is required.");
  }
  if (type !== existing.QST_TYPE) {
    throw new AppError(400, "TYPE_CHANGE_NOT_ALLOWED", "The question type cannot be changed.");
  }

  // CA-54: image_path and audio_path not accepted
  // (already enforced by ALLOWED_FIELDS_PUT check above)

  // CA-11 for PUT: choices must be absent for SPEED
  if (type === "SPEED" && "choices" in body) {
    throw new AppError(400, "VALIDATION_ERROR", "SPEED questions must not include choices.");
  }

  // Validate theme_id
  if (body.theme_id === undefined || body.theme_id === null) {
    throw new AppError(400, "VALIDATION_ERROR", "theme_id is required.");
  }
  if (typeof body.theme_id !== "string" || !UUID_REGEX.test(body.theme_id)) {
    throw new AppError(400, "INVALID_UUID", "The provided ID is not a valid UUID.");
  }
  const theme = findThemeById(db, body.theme_id);
  if (!theme) {
    throw new AppError(400, "INVALID_THEME", "The provided theme_id does not reference an existing theme.");
  }

  // Validate title
  if (body.title === undefined || body.title === null) {
    throw new AppError(400, "VALIDATION_ERROR", "title is required.");
  }
  const title = normalizeTitle(String(body.title));
  validateTitle(title);

  const existingTitle = findQuestionByTitle(db, title);
  if (existingTitle && existingTitle.QST_ID !== id) {
    throw new AppError(409, "QUESTION_ALREADY_EXISTS", "A question with this title already exists.");
  }

  // Validate choices (MCQ)
  let choices = null;
  if (type === "MCQ") {
    if (body.choices === undefined) {
      throw new AppError(400, "VALIDATION_ERROR", "MCQ questions must include choices.");
    }
    choices = validateChoices(body.choices);
  }

  // Validate correct_answer
  if (body.correct_answer === undefined || body.correct_answer === null) {
    throw new AppError(400, "VALIDATION_ERROR", "correct_answer is required.");
  }
  const correctAnswer = validateCorrectAnswer(body.correct_answer, choices);

  // Validate level, time_limit, points
  if (body.level === undefined || body.level === null) {
    throw new AppError(400, "VALIDATION_ERROR", "level is required.");
  }
  const level = validateIntRange(body.level, "level", 1, 5);

  if (body.time_limit === undefined || body.time_limit === null) {
    throw new AppError(400, "VALIDATION_ERROR", "time_limit is required.");
  }
  const timeLimit = validateIntRange(body.time_limit, "time_limit", 5, 60);

  if (body.points === undefined || body.points === null) {
    throw new AppError(400, "VALIDATION_ERROR", "points is required.");
  }
  const points = validateIntRange(body.points, "points", 1, 50);

  const fields = {
    themeId: body.theme_id, title,
    choiceA: choices ? choices[0] : null,
    choiceB: choices ? choices[1] : null,
    choiceC: choices ? choices[2] : null,
    choiceD: choices ? choices[3] : null,
    correctAnswer, level, timeLimit, points,
  };

  // CA-49: No change → skip update
  if (isIdentical(existing, fields)) {
    return toApiFormat(existing);
  }

  const now = new Date().toISOString();
  updateQuestion(db, id, fields, now);

  return toApiFormat({
    ...existing,
    QST_THEME_ID: body.theme_id, QST_TITLE: title,
    QST_CHOICE_A: choices ? choices[0] : null,
    QST_CHOICE_B: choices ? choices[1] : null,
    QST_CHOICE_C: choices ? choices[2] : null,
    QST_CHOICE_D: choices ? choices[3] : null,
    QST_CORRECT_ANSWER: correctAnswer, QST_LEVEL: level,
    QST_TIME_LIMIT: timeLimit, QST_POINTS: points,
    QST_LAST_UPDATED_AT: now,
  });
}

/**
 * Modifie partiellement une question (PATCH — CA-56 à CA-73, RFC 7396 JSON Merge Patch).
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @param {Object} body
 * @param {string} [uploadsDir=""] - Base directory for uploads (optional, used for CA-24 media deletion)
 * @returns {Object}
 */
export function patchQuestionById(db, id, body, uploadsDir = "") {
  validateUuid(id);

  const existing = findQuestionById(db, id);
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "The requested question was not found.");
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, "INVALID_JSON", "Request body must be a JSON object.");
  }

  // CA-60: type not allowed
  if ("type" in body) {
    throw new AppError(400, "TYPE_CHANGE_NOT_ALLOWED", "The question type cannot be changed.");
  }

  // CA-61: id not allowed
  if ("id" in body) {
    throw new AppError(400, "UNKNOWN_FIELDS", "Unknown field(s): id.");
  }

  // Check unknown fields (all fields not in ALLOWED_FIELDS_PATCH)
  const unknownFields = Object.keys(body).filter((k) => !ALLOWED_FIELDS_PATCH.has(k));
  if (unknownFields.length > 0) {
    throw new AppError(400, "UNKNOWN_FIELDS", `Unknown field(s): ${unknownFields.join(", ")}.`);
  }

  const fields = {};

  // theme_id
  if ("theme_id" in body) {
    const themeId = body.theme_id;
    if (themeId === null) {
      throw new AppError(400, "VALIDATION_ERROR", "theme_id cannot be null.");
    }
    if (typeof themeId !== "string" || !UUID_REGEX.test(themeId)) {
      throw new AppError(400, "INVALID_UUID", "The provided ID is not a valid UUID.");
    }
    const theme = findThemeById(db, themeId);
    if (!theme) {
      throw new AppError(400, "INVALID_THEME", "The provided theme_id does not reference an existing theme.");
    }
    fields.themeId = themeId;
  }

  // title
  if ("title" in body) {
    const rawTitle = body.title;
    if (rawTitle === null) {
      throw new AppError(400, "VALIDATION_ERROR", "title cannot be null.");
    }
    const title = normalizeTitle(String(rawTitle));
    validateTitle(title);
    const existingTitle = findQuestionByTitle(db, title);
    if (existingTitle && existingTitle.QST_ID !== id) {
      throw new AppError(409, "QUESTION_ALREADY_EXISTS", "A question with this title already exists.");
    }
    fields.title = title;
  }

  // choices
  if ("choices" in body) {
    // CA-65b: choices not allowed for SPEED
    if (existing.QST_TYPE === "SPEED") {
      throw new AppError(400, "VALIDATION_ERROR", "SPEED questions cannot have choices.");
    }
    // CA-59: null choices on MCQ
    if (body.choices === null) {
      throw new AppError(400, "VALIDATION_ERROR", "choices cannot be null for MCQ questions.");
    }
    const choices = validateChoices(body.choices);
    fields.choiceA = choices[0];
    fields.choiceB = choices[1];
    fields.choiceC = choices[2];
    fields.choiceD = choices[3];
  }

  // correct_answer
  if ("correct_answer" in body) {
    const rawAnswer = body.correct_answer;
    if (rawAnswer === null) {
      throw new AppError(400, "VALIDATION_ERROR", "correct_answer cannot be null.");
    }
    // Resolve the effective choices for validation
    const effectiveChoices = existing.QST_TYPE === "MCQ"
      ? [
          fields.choiceA ?? existing.QST_CHOICE_A,
          fields.choiceB ?? existing.QST_CHOICE_B,
          fields.choiceC ?? existing.QST_CHOICE_C,
          fields.choiceD ?? existing.QST_CHOICE_D,
        ]
      : null;
    fields.correctAnswer = validateCorrectAnswer(rawAnswer, effectiveChoices);
  }

  // level
  if ("level" in body) {
    if (body.level === null) {
      throw new AppError(400, "VALIDATION_ERROR", "level cannot be null.");
    }
    fields.level = validateIntRange(body.level, "level", 1, 5);
  }

  // time_limit
  if ("time_limit" in body) {
    if (body.time_limit === null) {
      throw new AppError(400, "VALIDATION_ERROR", "time_limit cannot be null.");
    }
    fields.timeLimit = validateIntRange(body.time_limit, "time_limit", 5, 60);
  }

  // points
  if ("points" in body) {
    if (body.points === null) {
      throw new AppError(400, "VALIDATION_ERROR", "points cannot be null.");
    }
    fields.points = validateIntRange(body.points, "points", 1, 50);
  }

  // image_path (CA-68, CA-24: delete file if set to null)
  if ("image_path" in body) {
    const val = body.image_path;
    if (val !== null) {
      if (typeof val !== "string" || val.trim().length === 0) {
        throw new AppError(400, "VALIDATION_ERROR", "image_path must be a non-empty string or null.");
      }
      fields.imagePath = val;
    } else {
      // CA-24: Delete physical file if image_path is set to null
      if (existing.QST_IMAGE_PATH && uploadsDir) {
        deleteMediaFile(uploadsDir, existing.QST_IMAGE_PATH).catch(() => {});
      }
      fields.imagePath = null;
    }
  }

  // audio_path (CA-69, CA-24: delete file if set to null)
  if ("audio_path" in body) {
    const val = body.audio_path;
    if (val !== null) {
      if (typeof val !== "string" || val.trim().length === 0) {
        throw new AppError(400, "VALIDATION_ERROR", "audio_path must be a non-empty string or null.");
      }
      fields.audioPath = val;
    } else {
      // CA-24: Delete physical file if audio_path is set to null
      if (existing.QST_AUDIO_PATH && uploadsDir) {
        deleteMediaFile(uploadsDir, existing.QST_AUDIO_PATH).catch(() => {});
      }
      fields.audioPath = null;
    }
  }

  // CA-73: Empty body or no effective changes
  if (Object.keys(fields).length === 0 || isIdentical(existing, fields)) {
    return toApiFormat(existing);
  }

  const now = new Date().toISOString();
  updateQuestion(db, id, fields, now);

  const updated = findQuestionById(db, id);
  return toApiFormat({ ...updated, QST_LAST_UPDATED_AT: now });
}

/**
 * Supprime une question (CA-74 à CA-77).
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 */
export function deleteQuestionById(db, id) {
  validateUuid(id);
  const existing = findQuestionById(db, id);
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "The requested question was not found.");
  }
  deleteQuestion(db, id);
}