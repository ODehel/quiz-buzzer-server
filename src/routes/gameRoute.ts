import { AppError } from "../errors/AppError.ts";
import { validateContentType } from "../middlewares/validateContentType.ts";
import { sendJson } from "../utils/sendJson.ts";
import { parseJsonBody } from "../utils/parseJsonBody.ts";
import {
  createGame,
  listGames,
  getGameById,
  updateGame,
  patchGame,
  deleteGame,
  getGameResults,
} from "../services/gameService.ts";
import { parsePagination, validateAllowedFields } from "../utils/validation.ts";
import { handleError, checkRateLimit, checkMethod } from "../utils/routeHelpers.ts";
import type { AppRequest, AuthMiddleware, AuthorizeMiddleware, IRateLimiter, AppConfig, RouteHandler, GameStatus } from "../types/index.ts";
import { ServerResponse } from "node:http";
import Database from "better-sqlite3";

/** Champs autorisés selon la méthode */
const ALLOWED_FIELDS_POST = new Set(["quiz_id", "participants"]);
const ALLOWED_FIELDS_PUT_PATCH = new Set(["quiz_id", "status", "participants"]);

interface GameResourceCallbacks {
  onGameStatusChange?: (status: GameStatus) => void;
  onGameDeleted?: (gameId: string) => void;
}

interface GameStartCallbacks {
  onGameStatusChange?: (status: GameStatus) => void;
}

/**
 * Crée le handler de la collection GET /api/v1/games et POST /api/v1/games.
 */
export function createGamesCollectionHandler(
  db: Database.Database,
  _config: Pick<AppConfig, "jwtSecret">,
  authenticate: AuthMiddleware,
  authorize: AuthorizeMiddleware,
  rateLimiter: IRateLimiter,
): RouteHandler {
  return async (req: AppRequest, res: ServerResponse, url: URL): Promise<void> => {
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

      const b = body as Record<string, unknown>;
      // CA-14 : champs requis
      if (b.quiz_id === undefined || b.participants === undefined) {
        throw new AppError(400, "VALIDATION_ERROR", "quiz_id and participants are required.");
      }

      // CA-1 à CA-10 : création de la partie (validation + insertion)
      const id = createGame(db, b.quiz_id as string, b.participants as Array<{ name: string }>);
      const game = getGameById(db, id);
      sendJson(res, 201, game);
    } catch (err) {
      handleError(req, res, err);
    }
  };
}

/**
 * Crée le handler de la ressource GET/PUT/PATCH/DELETE /api/v1/games/:id.
 */
export function createGameResourceHandler(
  db: Database.Database,
  _config: Pick<AppConfig, "jwtSecret">,
  authenticate: AuthMiddleware,
  authorize: AuthorizeMiddleware,
  rateLimiter: IRateLimiter,
  { onGameStatusChange, onGameDeleted }: GameResourceCallbacks = {},
): RouteHandler {
  return async (req: AppRequest, res: ServerResponse, url: URL): Promise<void> => {
    try {
      if (checkRateLimit(req, res, rateLimiter)) return;
      if (checkMethod(req, res, ["GET", "PUT", "PATCH", "DELETE"])) return;

      // CA-52 : Authentification
      authenticate(req);
      // CA-53 : Autorisation admin
      authorize(req);

      const match = url.pathname.match(/^\/api\/v1\/games\/([^/]+)$/);
      const id = match![1];

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

      const b = body as Record<string, unknown>;

      if (req.method === "PUT") {
        const rawParticipants = b.participants as Array<string | { name: string }> | undefined;
        const result = updateGame(db, id, {
          status: b.status as GameStatus | undefined,
          participants: rawParticipants?.map((p) => typeof p === "string" ? p : p.name),
          quizId: b.quiz_id as string | undefined,
        });
        // US-018 CA-7/CA-8: notify WebSocket layer of game state change
        if (b.status) {
          onGameStatusChange?.(b.status as GameStatus);
        }
        sendJson(res, 200, result);
        return;
      }

      // PATCH
      const result = patchGame(db, id, {
        status: b.status as GameStatus | undefined,
        participants: b.participants as Array<{ order: number; name: string }> | undefined,
        quizId: b.quiz_id as string | undefined,
      });
      // US-018 CA-7/CA-8: notify WebSocket layer of game state change
      if (b.status) {
        onGameStatusChange?.(b.status as GameStatus);
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
 */
export function createGameStartHandler(
  db: Database.Database,
  _config: Pick<AppConfig, "jwtSecret">,
  authenticate: AuthMiddleware,
  authorize: AuthorizeMiddleware,
  rateLimiter: IRateLimiter,
  { onGameStatusChange }: GameStartCallbacks = {},
): RouteHandler {
  return async (req: AppRequest, res: ServerResponse, url: URL): Promise<void> => {
    try {
      if (checkRateLimit(req, res, rateLimiter)) return;
      if (checkMethod(req, res, ["POST"])) return;

      authenticate(req);
      authorize(req);

      const match = url.pathname.match(/^\/api\/v1\/games\/([^/]+)\/start$/);
      const id = match![1];

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
 */
export function createGameResultsHandler(
  db: Database.Database,
  _config: Pick<AppConfig, "jwtSecret">,
  authenticate: AuthMiddleware,
  authorize: AuthorizeMiddleware,
  rateLimiter: IRateLimiter,
): RouteHandler {
  return async (req: AppRequest, res: ServerResponse, url: URL): Promise<void> => {
    try {
      if (checkRateLimit(req, res, rateLimiter)) return;
      if (checkMethod(req, res, ["GET"])) return;

      authenticate(req);
      authorize(req);

      const match = url.pathname.match(/^\/api\/v1\/games\/([^/]+)\/results$/);
      const id = match![1];

      sendJson(res, 200, getGameResults(db, id));
    } catch (err) {
      handleError(req, res, err);
    }
  };
}
