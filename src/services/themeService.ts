import { v7 as uuidv7 } from "uuid";
import { AppError } from "../errors/AppError.ts";
import {
  insertTheme,
  findById,
  findByName,
  findAll,
  updateTheme,
  deleteTheme
} from "../repositories/themeRepository.ts";
import { countQuestionsByTheme } from "../repositories/questionRepository.ts";
import { validateUuid, normalizeName, NAME_REGEX } from "../utils/validation.ts";
import Database from "better-sqlite3";
import type { ThemeRow, ThemeApiResponse, PaginatedResponse } from "../types/index.ts";

export { validateUuid, normalizeName };

/**
 * Valide le format d'un nom de thème (CA-3).
 */
function validateName(name: string): void {
  if (!name || name.length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "Theme name is required.");
  }
  if (name.length < 3) {
    throw new AppError(400, "VALIDATION_ERROR", "Theme name must be at least 3 characters long.");
  }
  if (name.length > 40) {
    throw new AppError(400, "VALIDATION_ERROR", "Theme name must not exceed 40 characters.");
  }
  if (!NAME_REGEX.test(name)) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Theme name must start with an uppercase letter and end with a letter or digit."
    );
  }
}

/**
 * Mappe une ligne DB vers le format JSON de l'API.
 */
function toApiFormat(row: ThemeRow): ThemeApiResponse {
  return {
    id: row.THM_ID,
    name: row.THM_NAME,
    created_at: row.THM_CREATED_AT,
    last_updated_at: row.THM_LAST_UPDATED_AT || null,
  };
}

/**
 * Crée un nouveau thème (CA-1 à CA-8).
 */
export function createTheme(db: Database.Database, name: string): ThemeApiResponse {
  const normalized = normalizeName(name);
  validateName(normalized);

  // Vérification unicité (CA-4)
  const existing = findByName(db, normalized);
  if (existing) {
    throw new AppError(409, "THEME_ALREADY_EXISTS", "A theme with this name already exists.");
  }

  // Génération cohérente UUIDv7 + timestamp (CA-5, CA-6)
  const now = new Date().toISOString();
  const id = uuidv7();

  insertTheme(db, { id, name: normalized, createdAt: now });

  return toApiFormat({
    THM_ID: id,
    THM_NAME: normalized,
    THM_CREATED_AT: now,
    THM_LAST_UPDATED_AT: null,
  });
}

/**
 * Récupère un thème par ID (CA-9 à CA-12).
 */
export function getTheme(db: Database.Database, id: string): ThemeApiResponse {
  validateUuid(id);
  const row = findById(db, id);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", "The requested theme was not found.");
  }
  return toApiFormat(row);
}

/**
 * Liste les thèmes avec pagination (CA-13 à CA-19).
 */
export function listThemes(db: Database.Database, page: number, limit: number): PaginatedResponse<ThemeApiResponse> {
  const { data, total } = findAll(db, page, limit);
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

  return {
    data: data.map(toApiFormat),
    page,
    limit,
    total,
    total_pages: totalPages,
  };
}

/**
 * Met à jour un thème (CA-20 à CA-27).
 */
export function updateThemeById(db: Database.Database, id: string, name: string): ThemeApiResponse {
  validateUuid(id);

  const existing = findById(db, id);
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "The requested theme was not found.");
  }

  const normalized = normalizeName(name);

  // CA-22 : Si le nom est identique (insensible à la casse), retourner sans modifier
  if (existing.THM_NAME.toLowerCase() === normalized.toLowerCase()) {
    return toApiFormat(existing);
  }

  validateName(normalized);

  // CA-24 : Unicité par rapport aux AUTRES thèmes
  const duplicate = findByName(db, normalized);
  if (duplicate && duplicate.THM_ID !== id) {
    throw new AppError(409, "THEME_ALREADY_EXISTS", "A theme with this name already exists.");
  }

  const now = new Date().toISOString();
  updateTheme(db, id, normalized, now);

  return toApiFormat({
    THM_ID: id,
    THM_NAME: normalized,
    THM_CREATED_AT: existing.THM_CREATED_AT,
    THM_LAST_UPDATED_AT: now,
  });
}

/**
 * Supprime un thème (CA-28 à CA-31).
 * Implémente la garde CA-30 de l'US-003 : refuse la suppression si des questions sont associées.
 */
export function deleteThemeById(db: Database.Database, id: string): void {
  validateUuid(id);

  const existing = findById(db, id);
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "The requested theme was not found.");
  }

  // CA-30 (implémenté dans l'US-004) : Refuser la suppression si des questions sont liées
  const questionCount = countQuestionsByTheme(db, id);
  if (questionCount > 0) {
    throw new AppError(
      409,
      "THEME_HAS_QUESTIONS",
      "Cannot delete this theme: questions are still associated with it."
    );
  }

  deleteTheme(db, id);
}
