import { AppError } from "../errors/AppError.js";
import { authenticate } from "../services/authService.js";
import { validateContentType } from "../middlewares/validateContentType.js";
import { logError } from "../utils/logger.js";

const ALLOWED_FIELDS = new Set(["username", "password"]);

/**
 * Envoie une réponse JSON.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {number} statusCode
 * @param {Object} body
 * @param {Object} [headers={}] - Headers supplémentaires (ex: Allow, Retry-After)
 */
function sendJson(res, statusCode, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    ...headers,
  });
  res.end(json);
}

/**
 * Envoie une réponse d'erreur AppError.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {AppError} err
 * @param {Object} [headers={}]
 */
function sendError(res, err, headers = {}) {
  sendJson(res, err.status, err.toJSON(), headers);
}

/**
 * Lit et parse le body JSON d'une requête.
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<Object>}
 * @throws {AppError} 400 INVALID_JSON
 */
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AppError(400, "INVALID_JSON", "Request body must be valid JSON."));
      }
    });
    req.on("error", (err) => reject(err));
  });
}

/**
 * Valide le body de la requête token.
 *
 * @param {Object} body
 * @throws {AppError} 400 UNKNOWN_FIELDS | 400 VALIDATION_ERROR
 */
function validateBody(body) {
  // Champs inconnus (CA-6, CA-12)
  const unknownFields = Object.keys(body).filter((k) => !ALLOWED_FIELDS.has(k));
  if (unknownFields.length > 0) {
    throw new AppError(
      400,
      "UNKNOWN_FIELDS",
      `Unknown field(s): ${unknownFields.join(", ")}.`
    );
  }

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
      if (req.method !== "POST") {
        sendJson(
          res,
          405,
          {
            status: 405,
            error: "METHOD_NOT_ALLOWED",
            message: `HTTP method ${req.method} is not allowed on this resource.`,
          },
          { Allow: "POST" }
        );
        return;
      }

      // CA-13 : Rate limiting par IP
      const ip = req.socket.remoteAddress || "unknown";
      const rateCheck = rateLimiter.check(ip);
      if (!rateCheck.allowed) {
        sendJson(
          res,
          429,
          {
            status: 429,
            error: "RATE_LIMIT_EXCEEDED",
            message: "Too many requests. Please retry in 60 seconds.",
          },
          { "Retry-After": String(rateCheck.retryAfter) }
        );
        return;
      }

      // CA-7 : Content-Type
      validateContentType(req);

      // CA-11 : Parse JSON
      const body = await parseJsonBody(req);

      // CA-6, CA-9, CA-10, CA-12 : Validation
      validateBody(body);

      // CA-1 à CA-5, CA-8 : Authentification + Token
      const result = await authenticate(db, config, body.username, body.password, ip);

      // 200 OK
      sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof AppError) {
        sendError(res, err);
      } else {
        // CA-21 : Erreur inattendue
        logError("INTERNAL_ERROR", { message: err.message });
        sendJson(res, 500, {
          status: 500,
          error: "INTERNAL_SERVER_ERROR",
          message: "An unexpected error occurred. Please try again later.",
        });
      }
    }
  };
}