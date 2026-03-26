import { AppError } from "../errors/AppError.js";
import { validateContentType } from "../middlewares/validateContentType.js";
import { sendJson, sendError } from "../utils/sendJson.js";
import { parseJsonBody } from "../utils/parseJsonBody.js";
import { logError } from "../utils/logger.js";
import {
  createQuestion,
  createQuestions,
  getQuestion,
  listQuestions,
  updateQuestionById,
  patchQuestionById,
  deleteQuestionById,
  parsePagination,
  parseFilters,
} from "../services/questionService.js";
import { countQuizzesByQuestion } from "../repositories/quizRepository.js";

/**
 * Gestion centralisée des erreurs pour les handlers de questions.
 */
function handleError(res, err) {
  if (err instanceof AppError) {
    sendError(res, err);
  } else {
    logError("INTERNAL_ERROR", { message: err.message });
    sendJson(res, 500, {
      status: 500,
      error: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred. Please try again later.",
    });
  }
}

/**
 * Crée le handler de la collection /api/v1/questions.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ jwtSecret: string }} config
 * @param {Function} authenticate
 * @param {Function} authorize
 * @param {import("../middlewares/rateLimiter.js").RateLimiter} rateLimiter
 */
export function createQuestionsCollectionHandler(db, config, authenticate, authorize, rateLimiter) {
  return async (req, res, url) => {
    try {
      // Rate limiting (CA-82)
      const ip = req.socket.remoteAddress || "unknown";
      const rateCheck = rateLimiter.check(ip);
      if (!rateCheck.allowed) {
        const retryAfter = rateCheck.retryAfter ?? 60;
        sendJson(res, 429, {
          status: 429,
          error: "RATE_LIMIT_EXCEEDED",
          message: `Too many requests. Please retry in ${retryAfter} seconds.`,
        }, { "Retry-After": String(retryAfter) });
        return;
      }

      // Méthode non supportée (CA-83)
      if (req.method !== "GET" && req.method !== "POST") {
        sendJson(res, 405, {
          status: 405,
          error: "METHOD_NOT_ALLOWED",
          message: `HTTP method ${req.method} is not allowed on this resource.`,
        }, { Allow: "GET, POST" });
        return;
      }

      // Authentification + Autorisation (CA-80, CA-81)
      authenticate(req);
      authorize(req);

      if (req.method === "POST") {
        // CA-20: Content-Type
        validateContentType(req);

        const body = await parseJsonBody(req);
        const question = createQuestion(db, body);
        sendJson(res, 201, question);
        return;
      }

      // GET — Liste paginée avec filtrage (CA-26 à CA-44)
      // Content-Type est ignoré sur GET

      const { page, limit } = parsePagination(url);
      const filters = parseFilters(url, db);
      const result = listQuestions(db, filters, page, limit);
      sendJson(res, 200, result);

    } catch (err) {
      handleError(res, err);
    }
  };
}

/**
 * Crée le handler de la ressource /api/v1/questions/:id.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ jwtSecret: string }} config
 * @param {Function} authenticate
 * @param {Function} authorize
 * @param {import("../middlewares/rateLimiter.js").RateLimiter} rateLimiter
 */
export function createQuestionResourceHandler(db, config, authenticate, authorize, rateLimiter) {
  return async (req, res, url) => {
    try {
      // Rate limiting (CA-82)
      const ip = req.socket.remoteAddress || "unknown";
      const rateCheck = rateLimiter.check(ip);
      if (!rateCheck.allowed) {
        const retryAfter = rateCheck.retryAfter ?? 60;
        sendJson(res, 429, {
          status: 429,
          error: "RATE_LIMIT_EXCEEDED",
          message: `Too many requests. Please retry in ${retryAfter} seconds.`,
        }, { "Retry-After": String(retryAfter) });
        return;
      }

      // Méthode non supportée (CA-83)
      if (!["GET", "PUT", "PATCH", "DELETE"].includes(req.method)) {
        sendJson(res, 405, {
          status: 405,
          error: "METHOD_NOT_ALLOWED",
          message: `HTTP method ${req.method} is not allowed on this resource.`,
        }, { Allow: "GET, PUT, PATCH, DELETE" });
        return;
      }

      // Authentification + Autorisation (CA-80, CA-81)
      authenticate(req);
      authorize(req);

      const id = url.pathname.split("/").pop();

      if (req.method === "GET") {
        // Content-Type est ignoré sur GET

        const question = getQuestion(db, id);
        sendJson(res, 200, question);
        return;
      }

      if (req.method === "PUT") {
        // CA-53: Content-Type
        validateContentType(req);
        const body = await parseJsonBody(req);
        const question = updateQuestionById(db, id, body);
        sendJson(res, 200, question);
        return;
      }

      if (req.method === "PATCH") {
        // CA-72: Content-Type
        validateContentType(req);
        const body = await parseJsonBody(req);
        const question = patchQuestionById(db, id, body);
        sendJson(res, 200, question);
        return;
      }

      // CA-36 : Garde — la question ne peut pas être supprimée si elle appartient à un quiz
      const quizCount = countQuizzesByQuestion(db, id);
      if (quizCount > 0) {
        throw new AppError(
          409,
          "QUESTION_IN_QUIZ",
          "Cannot delete this question: it belongs to one or more quizzes."
        );
      }

      // DELETE (CA-74 à CA-77)
      // Content-Type est ignoré sur DELETE

      deleteQuestionById(db, id);
      res.writeHead(204);
      res.end();

    } catch (err) {
      handleError(res, err);
    }
  };
}

/**
 * Crée le handler pour POST /api/v1/questions/bulk.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ jwtSecret: string }} config
 * @param {Function} authenticate
 * @param {Function} authorize
 * @param {import("../middlewares/rateLimiter.js").RateLimiter} rateLimiter
 */
export function createQuestionsBulkHandler(db, config, authenticate, authorize, rateLimiter) {
  return async (req, res) => {
    try {
      // Rate limiting
      const ip = req.socket.remoteAddress || "unknown";
      const rateCheck = rateLimiter.check(ip);
      if (!rateCheck.allowed) {
        const retryAfter = rateCheck.retryAfter ?? 60;
        sendJson(res, 429, {
          status: 429,
          error: "RATE_LIMIT_EXCEEDED",
          message: `Too many requests. Please retry in ${retryAfter} seconds.`,
        }, { "Retry-After": String(retryAfter) });
        return;
      }

      // Only POST is allowed
      if (req.method !== "POST") {
        sendJson(res, 405, {
          status: 405,
          error: "METHOD_NOT_ALLOWED",
          message: `HTTP method ${req.method} is not allowed on this resource.`,
        }, { Allow: "POST" });
        return;
      }

      // Authentification + Autorisation
      authenticate(req);
      authorize(req);

      // Content-Type
      validateContentType(req);

      const body = await parseJsonBody(req);
      const result = createQuestions(db, body);
      sendJson(res, 201, result);

    } catch (err) {
      handleError(res, err);
    }
  };
}