import { validateContentType } from "../middlewares/validateContentType.ts";
import { sendJson } from "../utils/sendJson.ts";
import { parseJsonBody } from "../utils/parseJsonBody.ts";
import {
  createQuiz,
  listQuizzes,
  updateQuizById,
  deleteQuizById,
  getQuizById,
} from "../services/quizService.ts";
import { parsePagination, validateAllowedFields } from "../utils/validation.ts";
import { handleError, checkRateLimit, checkMethod } from "../utils/routeHelpers.ts";
import { AppRequest, AuthMiddleware, AuthorizeMiddleware, IRateLimiter, AppConfig, RouteHandler } from "../types/index.ts";
import { ServerResponse } from "node:http";
import Database from "better-sqlite3";

/** Champs autorisés selon la méthode */
const ALLOWED_FIELDS_POST = new Set(["name", "question_ids"]);
const ALLOWED_FIELDS_PUT = new Set(["id", "name", "question_ids"]);

/**
 * Crée le handler de la collection GET /api/v1/quizzes et POST /api/v1/quizzes.
 */
export function createQuizzesCollectionHandler(
  db: Database.Database,
  config: Pick<AppConfig, "jwtSecret">,
  authenticate: AuthMiddleware,
  authorize: AuthorizeMiddleware,
  rateLimiter: IRateLimiter,
): RouteHandler {
  return async (req: AppRequest, res: ServerResponse, url: URL): Promise<void> => {
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

      const b = body as Record<string, unknown>;
      const quiz = createQuiz(db, b.name as string, b.question_ids as string[]);
      sendJson(res, 201, quiz);
    } catch (err) {
      handleError(req, res, err);
    }
  };
}

/**
 * Crée le handler de la ressource GET /api/v1/quizzes/:id, PUT /api/v1/quizzes/:id et DELETE /api/v1/quizzes/:id.
 */
export function createQuizResourceHandler(
  db: Database.Database,
  config: Pick<AppConfig, "jwtSecret">,
  authenticate: AuthMiddleware,
  authorize: AuthorizeMiddleware,
  rateLimiter: IRateLimiter,
): RouteHandler {
  return async (req: AppRequest, res: ServerResponse, url: URL): Promise<void> => {
    try {
      if (checkRateLimit(req, res, rateLimiter)) return;
      if (checkMethod(req, res, ["GET", "PUT", "DELETE"])) return;

      // CA-38 : Authentification
      authenticate(req);
      // CA-39 : Autorisation admin
      authorize(req);

      // Extraction de l'ID depuis l'URL
      const match = url.pathname.match(/^\/api\/v1\/quizzes\/([^/]+)$/);
      const id = match![1];

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

      const b = body as Record<string, unknown>;
      const quiz = updateQuizById(db, id, b.name as string, b.question_ids as string[], b.id as string | undefined);
      sendJson(res, 200, quiz);
    } catch (err) {
      handleError(req, res, err);
    }
  };
}
