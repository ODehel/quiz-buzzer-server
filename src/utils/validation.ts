import { AppError } from "../errors/AppError.ts";

/** Regex de validation UUID */
const UUID_REGEX: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Regex de validation du nom (CA-3) : commence par majuscule, finit par lettre ou chiffre, 3-40 chars */
export const NAME_REGEX: RegExp = /^[\p{Lu}][\p{L}\p{N} '\-]{1,38}[\p{L}\p{N}]$/u;

/**
 * Vérifie si une chaîne est un UUID valide (sans lever d'exception).
 */
export function isValidUuid(id: string): boolean {
  return UUID_REGEX.test(id);
}

/**
 * Valide qu'un ID est un UUID valide.
 *
 * @throws {AppError} 400 INVALID_UUID
 */
export function validateUuid(id: string): void {
  if (!isValidUuid(id)) {
    throw new AppError(400, "INVALID_UUID", "The provided ID is not a valid UUID.");
  }
}

/**
 * Normalise un nom ou titre : trim + collapse des espaces multiples (CA-2).
 */
export function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Valide et parse les paramètres de pagination.
 *
 * @throws {AppError} 400 INVALID_PAGINATION
 */
export function parsePagination(url: URL): { page: number; limit: number } {
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
 * @throws {AppError} 400 INVALID_BODY | 400 UNKNOWN_FIELDS
 */
export function validateAllowedFields(body: unknown, allowedFields: Set<string>, errorCode: string = "INVALID_BODY"): void {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, errorCode, "Request body must be a JSON object.");
  }
  const unknownFields = Object.keys(body as Record<string, unknown>).filter((k) => !allowedFields.has(k));
  if (unknownFields.length > 0) {
    throw new AppError(
      400,
      "UNKNOWN_FIELDS",
      `Unknown field(s): ${unknownFields.join(", ")}.`
    );
  }
}
