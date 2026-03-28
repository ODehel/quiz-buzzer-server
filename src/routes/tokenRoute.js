import { AppError } from "../errors/AppError.js";
import { authenticate } from "../services/authService.js";
import { validateContentType } from "../middlewares/validateContentType.js";
import { sendJson } from "../utils/sendJson.js";
import { parseJsonBody } from "../utils/parseJsonBody.js";
import { validateAllowedFields } from "../utils/validation.js";
import { handleError, checkRateLimit, checkMethod } from "../utils/routeHelpers.js";

const ALLOWED_FIELDS = new Set(["username", "password"]);

/**
 * Valide le body de la requête token.
 *
 * @param {Object} body
 * @throws {AppError} 400 UNKNOWN_FIELDS | 400 VALIDATION_ERROR
 */
function validateBody(body) {
  // Rejet des corps non-objet + champs inconnus (CA-6, CA-12)
  validateAllowedFields(body, ALLOWED_FIELDS);

  // Champs requis (CA-9, CA-10)
  const errors = [];
  if (body.username === undefined || body.username === null || String(body.username).trim() === "") {
    errors.push('Field "username" is required and must not be empty.');
  }
  if (body.password === undefined || body.password === null || String(body.password).trim() === "") {
    errors.push('Field "password" is required and must not be empty.');
  }
  if (errors.length > 0) {
    throw new AppError(400, "VALIDATION_ERROR", errors.join(" "));
  }
}

/**
 * Crée le handler de la route POST /api/v1/token.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ jwtSecret: string, jwtExpiration: number }} config
 * @param {import("../middlewares/rateLimiter.js").RateLimiter} rateLimiter
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>}
 */
export function createTokenHandler(db, config, rateLimiter) {
  return async (req, res) => {
    try {
      // CA-16 : Méthode non supportée
      if (checkMethod(req, res, ["POST"])) return;

      // CA-13 : Rate limiting par IP
      if (checkRateLimit(req, res, rateLimiter)) return;

      // CA-7 : Content-Type
      validateContentType(req);

      // CA-11 : Parse JSON
      const body = await parseJsonBody(req);

      // CA-6, CA-9, CA-10, CA-12 : Validation
      validateBody(body);

      // CA-1 à CA-5, CA-8 : Authentification + Token
      const ip = req.socket.remoteAddress || "unknown";
      const result = await authenticate(db, config, body.username, body.password, ip);

      // 200 OK
      sendJson(res, 200, result);
    } catch (err) {
      handleError(req, res, err);
    }
  };
}