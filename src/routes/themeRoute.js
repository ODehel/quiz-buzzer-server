import { AppError } from "../errors/AppError.js";
import { validateContentType } from "../middlewares/validateContentType.js";
import { sendJson } from "../utils/sendJson.js";
import { parseJsonBody } from "../utils/parseJsonBody.js";
import {
  createTheme,
  getTheme,
  listThemes,
  updateThemeById,
  deleteThemeById,
} from "../services/themeService.js";
import { parsePagination, validateAllowedFields } from "../utils/validation.js";
import { handleError, checkRateLimit, checkMethod } from "../utils/routeHelpers.js";

const ALLOWED_FIELDS_POST = new Set(["name"]);
const ALLOWED_FIELDS_PUT = new Set(["id", "name"]);

/**
 * Crée le handler de la collection /api/v1/themes.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ jwtSecret: string }} config
 * @param {Function} authenticate - middleware d'authentification
 * @param {Function} authorize - middleware d'autorisation (admin)
 * @param {import("../middlewares/rateLimiter.js").RateLimiter} rateLimiter
 */
export function createThemesCollectionHandler(db, config, authenticate, authorize, rateLimiter) {
  return async (req, res, url) => {
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

        if (body.name === undefined || body.name === null || String(body.name).trim() === "") {
          throw new AppError(400, "VALIDATION_ERROR", "Theme name is required.");
        }

        const theme = createTheme(db, String(body.name));
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
export function createThemeResourceHandler(db, config, authenticate, authorize, rateLimiter) {
  return async (req, res, url) => {
    try {
      if (checkRateLimit(req, res, rateLimiter)) return;
      if (checkMethod(req, res, ["GET", "PUT", "DELETE"])) return;

      // Authentification + Autorisation (CA-32, CA-33)
      authenticate(req);
      authorize(req);

      // Extraction de l'ID depuis l'URL
      const id = url.pathname.split("/").pop();

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

        // CA-23 : ID mismatch
        if (body.id !== undefined && body.id !== id) {
          throw new AppError(
            400,
            "ID_MISMATCH",
            "The ID in the request body does not match the URL parameter."
          );
        }

        if (body.name === undefined || body.name === null || String(body.name).trim() === "") {
          throw new AppError(400, "VALIDATION_ERROR", "Theme name is required.");
        }

        const theme = updateThemeById(db, id, String(body.name));
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
