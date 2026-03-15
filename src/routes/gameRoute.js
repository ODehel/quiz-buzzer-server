import { AppError } from "../errors/AppError.js";
import { validateContentType } from "../middlewares/validateContentType.js";
import { sendJson, sendError } from "../utils/sendJson.js";
import { parseJsonBody } from "../utils/parseJsonBody.js";
import { logError } from "../utils/logger.js";
import {
  createGame,
  listGames,
  getGameById,
  updateGame,
  patchGame,
  deleteGame,
} from "../services/gameService.js";

/** Champs autorisés selon la méthode */
const ALLOWED_FIELDS_POST = new Set(["quiz_id", "participants"]);
const ALLOWED_FIELDS_PUT_PATCH = new Set(["quiz_id", "status", "participants"]);

/**
 * Valide que le body est un objet JSON ne contenant que les champs autorisés.
 *
 * @param {unknown} body
 * @param {Set<string>} allowedFields
 * @throws {AppError} 400 INVALID_BODY | 400 UNKNOWN_FIELDS
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
 *
 * @param {import("node:http").ServerResponse} res
 * @param {unknown} err
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
 * Crée le handler de la collection GET /api/v1/games et POST /api/v1/games.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ jwtSecret: string }} config
 * @param {Function} authenticate
 * @param {Function} authorize
 * @param {import("../middlewares/rateLimiter.js").RateLimiter} rateLimiter
 */
export function createGamesCollectionHandler(db, config, authenticate, authorize, rateLimiter) {
  return async (req, res) => {
    try {
      // CA-54 : Rate limiting
      const ip = req.socket.remoteAddress || "unknown";
      const rateCheck = rateLimiter.check(ip);
      if (!rateCheck.allowed) {
        sendJson(
          res,
          429,
          {
            status: 429,
            error: "RATE_LIMIT_EXCEEDED",
            message: `Too many requests. Please retry in ${rateCheck.retryAfter} seconds.`,
          },
          { "Retry-After": String(rateCheck.retryAfter) }
        );
        return;
      }

      // CA-55 : Méthode supportée
      if (req.method !== "GET" && req.method !== "POST") {
        sendJson(
          res,
          405,
          {
            status: 405,
            error: "METHOD_NOT_ALLOWED",
            message: `HTTP method ${req.method} is not allowed on this resource.`,
          },
          { Allow: "GET, POST" }
        );
        return;
      }

      // CA-52 : Authentification
      authenticate(req);
      // CA-53 : Autorisation admin
      authorize(req);

      if (req.method === "GET") {
        sendJson(res, 200, listGames(db));
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
      createGame(db, body.quiz_id, body.participants);
      res.writeHead(201);
      res.end();
    } catch (err) {
      handleError(res, err);
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
export function createGameResourceHandler(db, config, authenticate, authorize, rateLimiter) {
  return async (req, res, url) => {
    try {
      // CA-54 : Rate limiting
      const ip = req.socket.remoteAddress || "unknown";
      const rateCheck = rateLimiter.check(ip);
      if (!rateCheck.allowed) {
        sendJson(
          res,
          429,
          {
            status: 429,
            error: "RATE_LIMIT_EXCEEDED",
            message: `Too many requests. Please retry in ${rateCheck.retryAfter} seconds.`,
          },
          { "Retry-After": String(rateCheck.retryAfter) }
        );
        return;
      }

      // CA-55 : Méthode supportée
      if (!["GET", "PUT", "PATCH", "DELETE"].includes(req.method)) {
        sendJson(
          res,
          405,
          {
            status: 405,
            error: "METHOD_NOT_ALLOWED",
            message: `HTTP method ${req.method} is not allowed on this resource.`,
          },
          { Allow: "GET, PUT, PATCH, DELETE" }
        );
        return;
      }

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
        deleteGame(db, id);
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
        sendJson(
          res,
          200,
          updateGame(db, id, {
            status: body.status,
            participants: body.participants,
            quizId: body.quiz_id,
          })
        );
        return;
      }

      // PATCH
      sendJson(
        res,
        200,
        patchGame(db, id, {
          status: body.status,
          participants: body.participants,
          quizId: body.quiz_id,
        })
      );
    } catch (err) {
      handleError(res, err);
    }
  };
}
