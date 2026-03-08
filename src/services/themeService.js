import { v7 as uuidv7 } from "uuid";
import { AppError } from "../errors/AppError.js";
import {
  insertTheme,
  findById,
  findByName,
  findAll,
  updateTheme,
  deleteTheme
} from "../repositories/themeRepository.js";

/** Regex de validation du nom (CA-3) */
const NAME_REGEX = /^[\p{Lu}][\p{L}\p{N} '\-]{1,38}[\p{L}\p{N}]$/u;

/** Regex de validation UUID */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalise un nom : trim + collapse des espaces multiples (CA-2).
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeName(name) {
  return name.trim().replace(/\s+/g, " ");
}

/**
 * Valide le format d'un nom de thème (CA-3).
 *
 * @param {string} name - Nom déjà normalisé
 * @throws {AppError} 400 VALIDATION_ERROR
 */
function validateName(name) {
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
 * Valide qu'un ID est un UUID valide (CA-11).
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
 * Mappe une ligne DB vers le format JSON de l'API.
 */
function toApiFormat(row) {
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
export function createTheme(db, name) {
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
export function getTheme(db, id) {
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
export function listThemes(db, page, limit) {
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
export function updateThemeById(db, id, name) {
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
 */
export function deleteThemeById(db, id) {
  validateUuid(id);

  const existing = findById(db, id);
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "The requested theme was not found.");
  }

  // TODO[CA-30]: Réactiver un garde bloquant la suppression lorsque des questions sont associées au thème
  // (à implémenter une fois la gestion des questions disponible).

  deleteTheme(db, id);
}