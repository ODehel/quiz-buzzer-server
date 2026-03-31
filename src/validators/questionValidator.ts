import { AppError } from "../errors/AppError.ts";
import { findById as findThemeById } from "../repositories/themeRepository.ts";
import { findQuestionByTitle } from "../repositories/questionRepository.ts";
import { isValidUuid, validateAllowedFields, normalizeName as normalizeTitle } from "../utils/validation.ts";
import Database from "better-sqlite3";

/** Champs autorisés selon la méthode */
export const ALLOWED_FIELDS_POST = new Set([
  "type", "theme_id", "title", "choices", "correct_answer",
  "level", "time_limit", "points",
]);
export const ALLOWED_FIELDS_PUT = new Set([
  "id", "type", "theme_id", "title", "choices", "correct_answer",
  "level", "time_limit", "points",
]);
export const ALLOWED_FIELDS_PATCH = new Set([
  "theme_id", "title", "choices", "correct_answer",
  "level", "time_limit", "points", "image_path", "audio_path",
]);

/**
 * Valide le format et la longueur du titre (CA-4).
 */
export function validateTitle(title: string): void {
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
 */
export function validateChoices(choices: unknown): string[] {
  if (!Array.isArray(choices) || choices.length !== 4) {
    throw new AppError(400, "VALIDATION_ERROR", "MCQ questions must have exactly 4 choices.");
  }
  const normalized = choices.map((c: unknown, i: number) => {
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
  const lower = normalized.map((c: string) => c.toLowerCase());
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
 */
export function validateCorrectAnswer(correctAnswer: unknown, choices: string[] | null): string {
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
    const match = choices.find((c: string) => c.toLowerCase() === trimmed.toLowerCase());
    if (!match) {
      throw new AppError(400, "VALIDATION_ERROR", "correct_answer must match one of the provided choices.");
    }
  }

  return trimmed;
}

/**
 * Valide un entier dans une plage donnée.
 */
export function validateIntRange(value: unknown, fieldName: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `${fieldName} must be an integer between ${min} and ${max}.`
    );
  }
  return value as number;
}

export function checkUnknownFields(body: Record<string, unknown>, allowedFields: Set<string>): void {
  validateAllowedFields(body, allowedFields, "INVALID_JSON");
}

interface QuestionFilters {
  theme_id?: string;
  type?: "MCQ" | "SPEED";
  level?: number;
  level_min?: number;
  level_max?: number;
  time_limit_min?: number;
  time_limit_max?: number;
  points_min?: number;
  points_max?: number;
}

/**
 * Valide et extrait les paramètres de filtrage de la query string.
 */
export function parseFilters(url: URL, db: Database.Database): QuestionFilters {
  const filters: QuestionFilters = {};

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
    if (!isValidUuid(rawThemeId)) {
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

export interface ValidatedQuestionFields {
  type: "MCQ" | "SPEED";
  themeId: string;
  title: string;
  choices: string[] | null;
  correctAnswer: string;
  level: number;
  timeLimit: number;
  points: number;
}

/**
 * Encapsulates the entire validation pipeline for creating a question.
 * Used by both createQuestion (single) and createQuestions (bulk).
 * When `prefix` is provided (for bulk), error messages get prefixed with it.
 */
export function validateQuestionBody(db: Database.Database, body: Record<string, unknown>, options?: { prefix?: string }): ValidatedQuestionFields {
  const prefix = options?.prefix ?? "";

  function prefixError(err: unknown): never {
    if (prefix && err instanceof AppError) {
      throw new AppError(err.status, err.error, `${prefix}${err.message}`);
    }
    throw err;
  }

  // Unknown fields
  if (prefix) {
    // For bulk, we do manual check to prefix the error
    const unknownFields = Object.keys(body).filter((k) => !ALLOWED_FIELDS_POST.has(k));
    if (unknownFields.length > 0) {
      throw new AppError(400, "UNKNOWN_FIELDS", `${prefix}Unknown field(s): ${unknownFields.join(", ")}.`);
    }
  } else {
    checkUnknownFields(body, ALLOWED_FIELDS_POST);
  }

  // Validate type (CA-6)
  const { type } = body;
  if (type !== "MCQ" && type !== "SPEED") {
    throw new AppError(400, "VALIDATION_ERROR", `${prefix}Question type must be 'MCQ' or 'SPEED'.`);
  }

  // CA-11: choices must be absent for SPEED
  if (type === "SPEED" && "choices" in body) {
    throw new AppError(400, "VALIDATION_ERROR", `${prefix}SPEED questions must not include choices.`);
  }

  // Validate theme_id (CA-7, CA-8)
  const { theme_id } = body;
  if (theme_id === undefined || theme_id === null) {
    throw new AppError(400, "VALIDATION_ERROR", `${prefix}theme_id is required.`);
  }
  if (typeof theme_id !== "string" || !isValidUuid(theme_id)) {
    throw new AppError(400, "INVALID_UUID", `${prefix}The provided ID is not a valid UUID.`);
  }
  const theme = findThemeById(db, theme_id);
  if (!theme) {
    throw new AppError(400, "INVALID_THEME", `${prefix}The provided theme_id does not reference an existing theme.`);
  }

  // Validate title (CA-3, CA-4, CA-5)
  if (body.title === undefined || body.title === null) {
    throw new AppError(400, "VALIDATION_ERROR", `${prefix}Question title is required.`);
  }
  const title = normalizeTitle(String(body.title));
  try {
    validateTitle(title);
  } catch (err) {
    prefixError(err);
  }

  const existingTitle = findQuestionByTitle(db, title);
  if (existingTitle) {
    throw new AppError(409, "QUESTION_ALREADY_EXISTS", `${prefix}A question with this title already exists.`);
  }

  // Validate choices (MCQ only — CA-9)
  let choices: string[] | null = null;
  if (type === "MCQ") {
    if (body.choices === undefined) {
      throw new AppError(400, "VALIDATION_ERROR", `${prefix}MCQ questions must include choices.`);
    }
    try {
      choices = validateChoices(body.choices);
    } catch (err) {
      prefixError(err);
    }
  }

  // Validate correct_answer (CA-10, CA-12)
  if (body.correct_answer === undefined || body.correct_answer === null) {
    throw new AppError(400, "VALIDATION_ERROR", `${prefix}correct_answer is required.`);
  }
  let correctAnswer: string;
  try {
    correctAnswer = validateCorrectAnswer(body.correct_answer, choices);
  } catch (err) {
    prefixError(err);
  }

  // Validate level, time_limit, points (CA-13, CA-14, CA-15)
  if (body.level === undefined || body.level === null) {
    throw new AppError(400, "VALIDATION_ERROR", `${prefix}level is required.`);
  }
  let level: number;
  try {
    level = validateIntRange(body.level, "level", 1, 5);
  } catch (err) {
    prefixError(err);
  }

  if (body.time_limit === undefined || body.time_limit === null) {
    throw new AppError(400, "VALIDATION_ERROR", `${prefix}time_limit is required.`);
  }
  let timeLimit: number;
  try {
    timeLimit = validateIntRange(body.time_limit, "time_limit", 5, 60);
  } catch (err) {
    prefixError(err);
  }

  if (body.points === undefined || body.points === null) {
    throw new AppError(400, "VALIDATION_ERROR", `${prefix}points is required.`);
  }
  let points: number;
  try {
    points = validateIntRange(body.points, "points", 1, 50);
  } catch (err) {
    prefixError(err);
  }

  return {
    type: type as "MCQ" | "SPEED",
    themeId: theme_id,
    title,
    choices,
    correctAnswer: correctAnswer!,
    level: level!,
    timeLimit: timeLimit!,
    points: points!,
  };
}
