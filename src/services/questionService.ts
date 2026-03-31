import { v7 as uuidv7 } from "uuid";
import { AppError } from "../errors/AppError.ts";
import { findById as findThemeById } from "../repositories/themeRepository.ts";
import {
  insertQuestion,
  insertQuestions,
  findQuestionById,
  findQuestionByTitle,
  findQuestions,
  updateQuestion,
  deleteQuestion,
} from "../repositories/questionRepository.ts";
import { deleteMediaFile } from "./mediaService.ts";
import { validateUuid, normalizeName as normalizeTitle, isValidUuid, parsePagination } from "../utils/validation.ts";
import Database from "better-sqlite3";
import type { QuestionApiResponse, PaginatedResponse, QuestionType } from "../types/index.ts";

import {
  ALLOWED_FIELDS_PUT,
  ALLOWED_FIELDS_PATCH,
  validateTitle,
  validateChoices,
  validateCorrectAnswer,
  validateIntRange,
  checkUnknownFields,
  parseFilters,
  validateQuestionBody,
} from "../validators/questionValidator.ts";

import { toApiFormat, isIdentical } from "../mappers/questionMapper.ts";

// Re-export for routes and tests
export { validateUuid, normalizeTitle, parsePagination };
export { parseFilters, toApiFormat };

/**
 * Crée une nouvelle question (CA-1 à CA-20).
 */
export function createQuestion(db: Database.Database, body: Record<string, unknown>): QuestionApiResponse {
  const { type, themeId, title, choices, correctAnswer, level, timeLimit, points } =
    validateQuestionBody(db, body);

  // Generate ID + timestamp (CA-16, CA-17)
  const now = new Date().toISOString();
  const id = uuidv7();

  insertQuestion(db, {
    id, type, themeId, title,
    choiceA: choices ? choices[0] : null,
    choiceB: choices ? choices[1] : null,
    choiceC: choices ? choices[2] : null,
    choiceD: choices ? choices[3] : null,
    correctAnswer, level, timeLimit, points, createdAt: now,
  });

  return toApiFormat({
    QST_ID: id, QST_TYPE: type as QuestionType, QST_THEME_ID: themeId, QST_TITLE: title,
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
 */
export function createQuestions(db: Database.Database, body: unknown): { created_count: number; questions: QuestionApiResponse[] } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, "VALIDATION_ERROR", "Request body must be a JSON object.");
  }

  if (!("questions" in body)) {
    throw new AppError(400, "VALIDATION_ERROR", "Body must contain a 'questions' array.");
  }

  const { questions } = body as { questions: unknown };

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
  const batchTitlesLower = new Map<string, number>(); // normalizedLower -> index
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (q !== null && typeof q === "object" && !Array.isArray(q) && typeof (q as Record<string, unknown>).title === "string") {
      const normalized = normalizeTitle(String((q as Record<string, unknown>).title));
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
  const records: Array<{
    id: string; type: QuestionType; themeId: string; title: string;
    choiceA: string | null; choiceB: string | null; choiceC: string | null; choiceD: string | null;
    correctAnswer: string; level: number; timeLimit: number; points: number; createdAt: string;
  }> = [];
  const apiResults: QuestionApiResponse[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] as Record<string, unknown> | null;
    const prefix = `[index ${i}] `;

    // Must be a plain object
    if (q === null || typeof q !== "object" || Array.isArray(q)) {
      throw new AppError(400, "VALIDATION_ERROR", `${prefix}Each question must be a JSON object.`);
    }

    const { type, themeId, title, choices, correctAnswer, level, timeLimit, points } =
      validateQuestionBody(db, q, { prefix });

    const id = uuidv7();
    records.push({
      id, type, themeId, title,
      choiceA: choices ? choices[0] : null,
      choiceB: choices ? choices[1] : null,
      choiceC: choices ? choices[2] : null,
      choiceD: choices ? choices[3] : null,
      correctAnswer, level, timeLimit, points, createdAt: now,
    });

    apiResults.push(toApiFormat({
      QST_ID: id, QST_TYPE: type as QuestionType, QST_THEME_ID: themeId, QST_TITLE: title,
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
 */
export function getQuestion(db: Database.Database, id: string): QuestionApiResponse {
  validateUuid(id);
  const row = findQuestionById(db, id);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", "The requested question was not found.");
  }
  return toApiFormat(row);
}

interface QuestionFilters {
  theme_id?: string;
  type?: QuestionType;
  level?: number;
  level_min?: number;
  level_max?: number;
  time_limit_min?: number;
  time_limit_max?: number;
  points_min?: number;
  points_max?: number;
}

/**
 * Liste les questions avec pagination et filtrage (CA-26 à CA-44).
 */
export function listQuestions(db: Database.Database, filters: QuestionFilters, page: number, limit: number): PaginatedResponse<QuestionApiResponse> {
  const { data, total } = findQuestions(db, filters, page, limit);
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

  return {
    data: data.map(toApiFormat),
    page, limit, total, total_pages: totalPages,
  };
}

interface QuestionUpdateFields {
  themeId?: string;
  title?: string;
  choiceA?: string | null;
  choiceB?: string | null;
  choiceC?: string | null;
  choiceD?: string | null;
  correctAnswer?: string;
  level?: number;
  timeLimit?: number;
  points?: number;
  imagePath?: string | null;
  audioPath?: string | null;
}

/**
 * Met à jour entièrement une question (PUT — CA-45 à CA-55).
 */
export function updateQuestionById(db: Database.Database, id: string, body: Record<string, unknown>): QuestionApiResponse {
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
  if (typeof body.theme_id !== "string" || !isValidUuid(body.theme_id)) {
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
  let choices: string[] | null = null;
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

  const fields: QuestionUpdateFields = {
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
 */
export function patchQuestionById(db: Database.Database, id: string, body: Record<string, unknown>, uploadsDir: string = ""): QuestionApiResponse {
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

  const fields: QuestionUpdateFields = {};

  // theme_id
  if ("theme_id" in body) {
    const themeId = body.theme_id;
    if (themeId === null) {
      throw new AppError(400, "VALIDATION_ERROR", "theme_id cannot be null.");
    }
    if (typeof themeId !== "string" || !isValidUuid(themeId)) {
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
    const effectiveChoices: string[] | null = existing.QST_TYPE === "MCQ"
      ? [
          fields.choiceA ?? existing.QST_CHOICE_A!,
          fields.choiceB ?? existing.QST_CHOICE_B!,
          fields.choiceC ?? existing.QST_CHOICE_C!,
          fields.choiceD ?? existing.QST_CHOICE_D!,
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
  return toApiFormat({ ...updated!, QST_LAST_UPDATED_AT: now });
}

/**
 * Supprime une question (CA-74 à CA-77).
 */
export function deleteQuestionById(db: Database.Database, id: string): void {
  validateUuid(id);
  const existing = findQuestionById(db, id);
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "The requested question was not found.");
  }
  deleteQuestion(db, id);
}
