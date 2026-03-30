import { AppError } from "../errors/AppError.js";
import { validateContentType } from "../middlewares/validateContentType.js";
import { sendJson } from "../utils/sendJson.js";
import { parseJsonBody } from "../utils/parseJsonBody.js";
import {
  createGame,
  listGames,
  getGameById,
  updateGame,
  patchGame,
  deleteGame,
  getGameResults,
} from "../services/gameService.js";
import { parsePagination, validateAllowedFields } from "../utils/validation.js";
import { handleError, checkRateLimit, checkMethod } from "../utils/routeHelpers.js";

/** Champs autorisés selon la méthode */
const ALLOWED_FIELDS_POST = new Set(["quiz_id", "participants"]);
const ALLOWED_FIELDS_PUT_PATCH = new Set(["quiz_id", "status", "participants"]);

/**
 * Crée le handler de la collection GET /api/v1/games et POST /api/v1/games.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ jwtSecret: string }} config
 * @param {Function} authenticate
 * @param {Function} authorize
 * @param {import("../middlewares/rateLimiter.js").RateLimiter} rateLimiter
 */
export function createGamesCollectionHandler(db, config, authenticate, authorize, rateLimiter) {
  return async (req, res, url) => {
    try {
      if (checkRateLimit(req, res, rateLimiter)) return;
      if (checkMethod(req, res, ["GET", "POST"])) return;

      // CA-52 : Authentification
      authenticate(req);
      // CA-53 : Autorisation admin
      authorize(req);

      if (req.method === "GET") {
        const { page, limit } = parsePagination(url);
        const result = listGames(db, page, limit);
        sendJson(res, 200, result);
        return;
      }

      // POST
      // CA-12 : Content-Type
      validateContentType(req);
      const body = await parseJsonBody(req);
      // CA-11 : champs inconnus
      validateAllowedFields(body, ALLOWED_FIELDS_POST);

      // CA-14 : champs requis
      if (body.quiz_id === undefined || body.participants === undefined) {
        throw new AppError(400, "VALIDATION_ERROR", "quiz_id and participants are required.");
      }

      // CA-1 à CA-10 : création de la partie (validation + insertion)
      const id = createGame(db, body.quiz_id, body.participants);
      const game = getGameById(db, id);
      sendJson(res, 201, game);
    } catch (err) {
      handleError(req, res, err);
    }
  };
}

/**
 * Crée le handler de la ressource GET/PUT/PATCH/DELETE /api/v1/games/:id.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ jwtSecret: string }} config
 * @param {Function} authenticate
 * @param {Function} authorize
 * @param {import("../middlewares/rateLimiter.js").RateLimiter} rateLimiter
 */
export function createGameResourceHandler(db, config, authenticate, authorize, rateLimiter, { onGameStatusChange, onGameDeleted } = {}) {
  return async (req, res, url) => {
    try {
      if (checkRateLimit(req, res, rateLimiter)) return;
      if (checkMethod(req, res, ["GET", "PUT", "PATCH", "DELETE"])) return;

      // CA-52 : Authentification
      authenticate(req);
      // CA-53 : Autorisation admin
      authorize(req);

      const match = url.pathname.match(/^\/api\/v1\/games\/([^/]+)$/);
      const id = match[1];

      if (req.method === "GET") {
        sendJson(res, 200, getGameById(db, id));
        return;
      }

      if (req.method === "DELETE") {
        // CA-51 : body éventuel ignoré silencieusement
        // Point de vigilance US-010 : passer callback pour nettoyage des timers en mémoire avant suppression SQL
        deleteGame(db, id, onGameDeleted);
        res.writeHead(204);
        res.end();
        return;
      }

      // PUT ou PATCH
      // CA-35 / CA-46 : Content-Type
      validateContentType(req);
      const body = await parseJsonBody(req);
      // CA-32 / CA-43 : champs inconnus
      validateAllowedFields(body, ALLOWED_FIELDS_PUT_PATCH);

      if (req.method === "PUT") {
        const result = updateGame(db, id, {
          status: body.status,
          participants: body.participants,
          quizId: body.quiz_id,
        });
        // US-018 CA-7/CA-8: notify WebSocket layer of game state change
        if (body.status) {
          onGameStatusChange?.(body.status);
        }
        sendJson(res, 200, result);
        return;
      }

      // PATCH
      const result = patchGame(db, id, {
        status: body.status,
        participants: body.participants,
        quizId: body.quiz_id,
      });
      // US-018 CA-7/CA-8: notify WebSocket layer of game state change
      if (body.status) {
        onGameStatusChange?.(body.status);
      }
      sendJson(res, 200, result);
    } catch (err) {
      handleError(req, res, err);
    }
  };
}

/**
 * Crée le handler POST /api/v1/games/:id/start.
 * Raccourci pour passer le statut de PENDING à OPEN.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ jwtSecret: string }} config
 * @param {Function} authenticate
 * @param {Function} authorize
 * @param {import("../middlewares/rateLimiter.js").RateLimiter} rateLimiter
 */
export function createGameStartHandler(db, config, authenticate, authorize, rateLimiter, { onGameStatusChange } = {}) {
  return async (req, res, url) => {
    try {
      if (checkRateLimit(req, res, rateLimiter)) return;
      if (checkMethod(req, res, ["POST"])) return;

      authenticate(req);
      authorize(req);

      const match = url.pathname.match(/^\/api\/v1\/games\/([^/]+)\/start$/);
      const id = match[1];

      const result = updateGame(db, id, { status: "OPEN" });
      onGameStatusChange?.("OPEN");
      sendJson(res, 200, result);
    } catch (err) {
      handleError(req, res, err);
    }
  };
}

/**
 * Crée le handler GET /api/v1/games/:id/results.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ jwtSecret: string }} config
 * @param {Function} authenticate
 * @param {Function} authorize
 * @param {import("../middlewares/rateLimiter.js").RateLimiter} rateLimiter
 */
export function createGameResultsHandler(db, config, authenticate, authorize, rateLimiter) {
  return async (req, res, url) => {
    try {
      if (checkRateLimit(req, res, rateLimiter)) return;
      if (checkMethod(req, res, ["GET"])) return;

      authenticate(req);
      authorize(req);

      const match = url.pathname.match(/^\/api\/v1\/games\/([^/]+)\/results$/);
      const id = match[1];

      sendJson(res, 200, getGameResults(db, id));
    } catch (err) {
      handleError(req, res, err);
    }
  };
}
