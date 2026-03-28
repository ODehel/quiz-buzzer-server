import { AppError } from "../errors/AppError.js";

/** Regex de validation UUID */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Regex de validation du nom (CA-3) : commence par majuscule, finit par lettre ou chiffre, 3-40 chars */
export const NAME_REGEX = /^[\p{Lu}][\p{L}\p{N} '\-]{1,38}[\p{L}\p{N}]$/u;

/**
 * Vérifie si une chaîne est un UUID valide (sans lever d'exception).
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isValidUuid(id) {
  return UUID_REGEX.test(id);
}

/**
 * Valide qu'un ID est un UUID valide.
 *
 * @param {string} id
 * @throws {AppError} 400 INVALID_UUID
 */
export function validateUuid(id) {
  if (!isValidUuid(id)) {
    throw new AppError(400, "INVALID_UUID", "The provided ID is not a valid UUID.");
  }
}

/**
 * Normalise un nom ou titre : trim + collapse des espaces multiples (CA-2).
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeName(value) {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Valide et parse les paramètres de pagination.
 *
 * @param {URL} url
 * @returns {{ page: number, limit: number }}
 * @throws {AppError} 400 INVALID_PAGINATION
 */
export function parsePagination(url) {
  const rawPage = url.searchParams.get("page");
  const rawLimit = url.searchParams.get("limit");

  let page = rawPage !== null ? Number(rawPage) : 1;
  let limit = rawLimit !== null ? Number(rawLimit) : 20;

  if (
    !Number.isInteger(page) || page < 1 ||
    !Number.isInteger(limit) || limit < 1 || limit > 100
  ) {
    throw new AppError(400, "INVALID_PAGINATION", "Invalid pagination parameters.");
  }

  return { page, limit };
}

/**
 * Valide que le body ne contient que les champs autorisés.
 *
 * @param {unknown} body
 * @param {Set<string>} allowedFields
 * @param {string} [errorCode="INVALID_BODY"] - Code d'erreur pour un body invalide
 * @throws {AppError} 400 INVALID_BODY | 400 UNKNOWN_FIELDS
 */
export function validateAllowedFields(body, allowedFields, errorCode = "INVALID_BODY") {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, errorCode, "Request body must be a JSON object.");
  }
  const unknownFields = Object.keys(body).filter((k) => !allowedFields.has(k));
  if (unknownFields.length > 0) {
    throw new AppError(
      400,
      "UNKNOWN_FIELDS",
      `Unknown field(s): ${unknownFields.join(", ")}.`
    );
  }
}
