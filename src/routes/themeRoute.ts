import { AppError } from "../errors/AppError.ts";
import { validateContentType } from "../middlewares/validateContentType.ts";
import { sendJson } from "../utils/sendJson.ts";
import { parseJsonBody } from "../utils/parseJsonBody.ts";
import {
  createTheme,
  getTheme,
  listThemes,
  updateThemeById,
  deleteThemeById,
} from "../services/themeService.ts";
import { parsePagination, validateAllowedFields } from "../utils/validation.ts";
import { handleError, checkRateLimit, checkMethod } from "../utils/routeHelpers.ts";
import type { AppRequest, AuthMiddleware, AuthorizeMiddleware, IRateLimiter, AppConfig, RouteHandler } from "../types/index.ts";
import { ServerResponse } from "node:http";
import Database from "better-sqlite3";

const ALLOWED_FIELDS_POST = new Set(["name"]);
const ALLOWED_FIELDS_PUT = new Set(["id", "name"]);

/**
 * Crée le handler de la collection /api/v1/themes.
 */
export function createThemesCollectionHandler(
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

      // Authentification + Autorisation (CA-32, CA-33)
      authenticate(req);
      authorize(req);

      if (req.method === "POST") {
        // CA-8 : Content-Type
        validateContentType(req);

        const body = await parseJsonBody(req);
        validateAllowedFields(body, ALLOWED_FIELDS_POST, "INVALID_JSON");

        const b = body as Record<string, unknown>;
        if (b.name === undefined || b.name === null || String(b.name).trim() === "") {
          throw new AppError(400, "VALIDATION_ERROR", "Theme name is required.");
        }

        const theme = createTheme(db, String(b.name));
        sendJson(res, 201, theme);
        return;
      }

      // GET — Liste paginée (CA-13 à CA-19)
      const { page, limit } = parsePagination(url);
      const result = listThemes(db, page, limit);
      sendJson(res, 200, result);

    } catch (err) {
      handleError(req, res, err);
    }
  };
}

/**
 * Crée le handler de la ressource /api/v1/themes/:id.
 */
export function createThemeResourceHandler(
  db: Database.Database,
  _config: Pick<AppConfig, "jwtSecret">,
  authenticate: AuthMiddleware,
  authorize: AuthorizeMiddleware,
  rateLimiter: IRateLimiter,
): RouteHandler {
  return async (req: AppRequest, res: ServerResponse, url: URL): Promise<void> => {
    try {
      if (checkRateLimit(req, res, rateLimiter)) return;
      if (checkMethod(req, res, ["GET", "PUT", "DELETE"])) return;

      // Authentification + Autorisation (CA-32, CA-33)
      authenticate(req);
      authorize(req);

      // Extraction de l'ID depuis l'URL
      const id = url.pathname.split("/").pop() as string;

      if (req.method === "GET") {
        const theme = getTheme(db, id);
        sendJson(res, 200, theme);
        return;
      }

      if (req.method === "PUT") {
        // CA-26 : Content-Type
        validateContentType(req);

        const body = await parseJsonBody(req);
        validateAllowedFields(body, ALLOWED_FIELDS_PUT, "INVALID_JSON");

        const b = body as Record<string, unknown>;
        // CA-23 : ID mismatch
        if (b.id !== undefined && b.id !== id) {
          throw new AppError(
            400,
            "ID_MISMATCH",
            "The ID in the request body does not match the URL parameter."
          );
        }

        if (b.name === undefined || b.name === null || String(b.name).trim() === "") {
          throw new AppError(400, "VALIDATION_ERROR", "Theme name is required.");
        }

        const theme = updateThemeById(db, id, String(b.name));
        sendJson(res, 200, theme);
        return;
      }

      // DELETE (CA-28 à CA-31)
      deleteThemeById(db, id);
      res.writeHead(204);
      res.end();

    } catch (err) {
      handleError(req, res, err);
    }
  };
}
