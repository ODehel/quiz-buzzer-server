import { AppError } from "../errors/AppError.js";
import { validateContentType } from "../middlewares/validateContentType.js";
import { sendJson, sendError } from "../utils/sendJson.js";
import { parseJsonBody } from "../utils/parseJsonBody.js";
import { logError } from "../utils/logger.js";
import {
  createQuiz,
  listQuizzes,
  updateQuizById,
  deleteQuizById,
  getQuizById,
} from "../services/quizService.js";

/** Champs autorisés selon la méthode */
const ALLOWED_FIELDS_POST = new Set(["name", "question_ids"]);
const ALLOWED_FIELDS_PUT = new Set(["id", "name", "question_ids"]);

/**
 * Valide et parse les paramètres de pagination.
 */
function parsePagination(url) {
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
 * Valide que le body ne contient que les champs autorisés (CA-12).
 *
 * @param {Object} body
 * @param {Set<string>} allowedFields
 * @throws {AppError} 400 UNKNOWN_FIELDS | 400 INVALID_BODY
 */
function validateAllowedFields(body, allowedFields) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, "INVALID_BODY", "Request body must be a JSON object.");
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

/**
 * Gestion centralisée des erreurs.
 */
function handleError(req, res, err) {
  if (err instanceof AppError) {
    sendError(res, err);
  } else {
    logError("INTERNAL_ERROR", { message: err.message });
    sendJson(res, 500, {
      status: 500,
      error: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred. Please try again later.",
      correlation_id: req.correlationId,
    });
  }
}

/**
 * Crée le handler de la collection GET /api/v1/quizzes et POST /api/v1/quizzes.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ jwtSecret: string }} config
 * @param {Function} authenticate
 * @param {Function} authorize
 * @param {import("../middlewares/rateLimiter.js").RateLimiter} rateLimiter
 */
export function createQuizzesCollectionHandler(db, config, authenticate, authorize, rateLimiter) {
  return async (req, res, url) => {
    try {
      // CA-40 : Rate limiting
      const ip = req.socket.remoteAddress || "unknown";
      const rateCheck = rateLimiter.check(ip);
      if (!rateCheck.allowed) {
        sendJson(res, 429, {
          status: 429,
          error: "RATE_LIMIT_EXCEEDED",
          message: `Too many requests. Please retry in ${rateCheck.retryAfter} seconds.`,
        }, { "Retry-After": String(rateCheck.retryAfter) });
        return;
      }

      // CA-41 : Méthode supportée
      if (req.method !== "GET" && req.method !== "POST") {
        sendJson(res, 405, {
          status: 405,
          error: "METHOD_NOT_ALLOWED",
          message: `HTTP method ${req.method} is not allowed on this resource.`,
        }, { Allow: "GET, POST" });
        return;
      }

      // CA-38 : Authentification
      authenticate(req);
      // CA-39 : Autorisation admin
      authorize(req);

      if (req.method === "GET") {
        // Content-Type est ignoré sur GET

        // CA-18 : Filtrage optionnel par nom
        const nameFilter = url.searchParams.get("name") || null;
        // CA-15 : Pagination
        const { page, limit } = parsePagination(url);
        const all = listQuizzes(db, nameFilter);
        const total = all.length;
        const offset = (page - 1) * limit;
        const data = all.slice(offset, offset + limit);
        const total_pages = total === 0 ? 0 : Math.ceil(total / limit);
        sendJson(res, 200, { data, page, limit, total, total_pages });
        return;
      }

      // POST
      // CA-13 : Content-Type
      validateContentType(req);
      const body = await parseJsonBody(req);
      validateAllowedFields(body, ALLOWED_FIELDS_POST);

      const quiz = createQuiz(db, body.name, body.question_ids);
      sendJson(res, 201, quiz);
    } catch (err) {
      handleError(req, res, err);
    }
  };
}

/**
 * Crée le handler de la ressource GET /api/v1/quizzes/:id, PUT /api/v1/quizzes/:id et DELETE /api/v1/quizzes/:id.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ jwtSecret: string }} config
 * @param {Function} authenticate
 * @param {Function} authorize
 * @param {import("../middlewares/rateLimiter.js").RateLimiter} rateLimiter
 */
export function createQuizResourceHandler(db, config, authenticate, authorize, rateLimiter) {
  return async (req, res, url) => {
    try {
      // CA-40 : Rate limiting
      const ip = req.socket.remoteAddress || "unknown";
      const rateCheck = rateLimiter.check(ip);
      if (!rateCheck.allowed) {
        sendJson(res, 429, {
          status: 429,
          error: "RATE_LIMIT_EXCEEDED",
          message: `Too many requests. Please retry in ${rateCheck.retryAfter} seconds.`,
        }, { "Retry-After": String(rateCheck.retryAfter) });
        return;
      }

      // CA-41 : Méthode supportée
      if (req.method !== "GET" && req.method !== "PUT" && req.method !== "DELETE") {
        sendJson(res, 405, {
          status: 405,
          error: "METHOD_NOT_ALLOWED",
          message: `HTTP method ${req.method} is not allowed on this resource.`,
        }, { Allow: "GET, PUT, DELETE" });
        return;
      }

      // CA-38 : Authentification
      authenticate(req);
      // CA-39 : Autorisation admin
      authorize(req);

      // Extraction de l'ID depuis l'URL
      const match = url.pathname.match(/^\/api\/v1\/quizzes\/([^/]+)$/);
      const id = match[1];

      if (req.method === "GET") {
        // Content-Type est ignoré sur GET

        const quiz = getQuizById(db, id);
        sendJson(res, 200, quiz);
        return;
      }

      if (req.method === "DELETE") {
        // Content-Type est ignoré sur DELETE

        // CA-35 : body ignoré silencieusement
        deleteQuizById(db, id);
        res.writeHead(204);
        res.end();
        return;
      }

      // PUT
      // CA-28 : Content-Type
      validateContentType(req);
      const body = await parseJsonBody(req);
      validateAllowedFields(body, ALLOWED_FIELDS_PUT);

      const quiz = updateQuizById(db, id, body.name, body.question_ids, body.id);
      sendJson(res, 200, quiz);
    } catch (err) {
      handleError(req, res, err);
    }
  };
}