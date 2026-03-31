import { AppError } from "../errors/AppError.ts";
import { sendJson } from "../utils/sendJson.ts";
import { parseSoundFormData } from "../middlewares/soundUpload.ts";
import {
  createSound,
  getSound,
  listSounds,
  deleteSoundById,
} from "../services/soundService.ts";
import { parsePagination } from "../utils/validation.ts";
import { handleError, checkRateLimit, checkMethod } from "../utils/routeHelpers.ts";
import { AppRequest, AuthMiddleware, AuthorizeMiddleware, IRateLimiter, AppConfig, RouteHandler } from "../types/index.ts";
import { ServerResponse } from "node:http";
import Database from "better-sqlite3";

/**
 * Handler de la collection /api/v1/sounds (GET list, POST upload).
 */
export function createSoundsCollectionHandler(
  db: Database.Database,
  config: Pick<AppConfig, "jwtSecret">,
  authenticate: AuthMiddleware,
  authorize: AuthorizeMiddleware,
  rateLimiter: IRateLimiter,
  uploadsDir: string,
): RouteHandler {
  return async (req: AppRequest, res: ServerResponse, url: URL): Promise<void> => {
    try {
      if (checkRateLimit(req, res, rateLimiter)) return;
      if (checkMethod(req, res, ["GET", "POST"])) return;

      // CA-31, CA-32: Authentification + Autorisation
      authenticate(req);
      authorize(req);

      if (req.method === "POST") {
        // CA-10: Content-Type validation
        const contentType = req.headers["content-type"] || "";
        if (!contentType.startsWith("multipart/form-data")) {
          throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be 'multipart/form-data'.");
        }

        const { name, file } = await parseSoundFormData(req);
        const sound = await createSound(db, name, file, uploadsDir);
        sendJson(res, 201, sound);
        return;
      }

      // GET — Liste paginée (CA-11 à CA-14)
      const { page, limit } = parsePagination(url);
      const result = listSounds(db, page, limit);
      sendJson(res, 200, result);

    } catch (err) {
      handleError(req, res, err);
    }
  };
}

/**
 * Handler de la ressource /api/v1/sounds/:id (GET, DELETE).
 */
export function createSoundResourceHandler(
  db: Database.Database,
  config: Pick<AppConfig, "jwtSecret">,
  authenticate: AuthMiddleware,
  authorize: AuthorizeMiddleware,
  rateLimiter: IRateLimiter,
  uploadsDir: string,
): RouteHandler {
  return async (req: AppRequest, res: ServerResponse, url: URL): Promise<void> => {
    try {
      if (checkRateLimit(req, res, rateLimiter)) return;
      if (checkMethod(req, res, ["GET", "DELETE"])) return;

      // CA-31, CA-32: Authentification + Autorisation
      authenticate(req);
      authorize(req);

      const id = url.pathname.split("/").pop() as string;

      if (req.method === "GET") {
        const sound = getSound(db, id);
        sendJson(res, 200, sound);
        return;
      }

      // DELETE (CA-18 à CA-21)
      await deleteSoundById(db, id, uploadsDir);
      res.writeHead(204);
      res.end();

    } catch (err) {
      handleError(req, res, err);
    }
  };
}
