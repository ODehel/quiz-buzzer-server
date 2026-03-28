import { validateContentType } from "../middlewares/validateContentType.js";
import { sendJson } from "../utils/sendJson.js";
import { parseJsonBody } from "../utils/parseJsonBody.js";
import {
  createQuiz,
  listQuizzes,
  updateQuizById,
  deleteQuizById,
  getQuizById,
} from "../services/quizService.js";
import { parsePagination, validateAllowedFields } from "../utils/validation.js";
import { handleError, checkRateLimit, checkMethod } from "../utils/routeHelpers.js";

/** Champs autorisés selon la méthode */
const ALLOWED_FIELDS_POST = new Set(["name", "question_ids"]);
const ALLOWED_FIELDS_PUT = new Set(["id", "name", "question_ids"]);

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
      if (checkRateLimit(req, res, rateLimiter)) return;
      if (checkMethod(req, res, ["GET", "POST"])) return;

      // CA-38 : Authentification
      authenticate(req);
      // CA-39 : Autorisation admin
      authorize(req);

      if (req.method === "GET") {
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
      if (checkRateLimit(req, res, rateLimiter)) return;
      if (checkMethod(req, res, ["GET", "PUT", "DELETE"])) return;

      // CA-38 : Authentification
      authenticate(req);
      // CA-39 : Autorisation admin
      authorize(req);

      // Extraction de l'ID depuis l'URL
      const match = url.pathname.match(/^\/api\/v1\/quizzes\/([^/]+)$/);
      const id = match[1];

      if (req.method === "GET") {
        const quiz = getQuizById(db, id);
        sendJson(res, 200, quiz);
        return;
      }

      if (req.method === "DELETE") {
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
