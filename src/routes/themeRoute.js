import { AppError } from "../errors/AppError.js";
import { validateContentType } from "../middlewares/validateContentType.js";
import { sendJson, sendError } from "../utils/sendJson.js";
import { parseJsonBody } from "../utils/parseJsonBody.js";
import { logError } from "../utils/logger.js";
import {
  createTheme,
  getTheme,
  listThemes,
  updateThemeById,
  deleteThemeById,
} from "../services/themeService.js";

const ALLOWED_FIELDS_POST = new Set(["name"]);
const ALLOWED_FIELDS_PUT = new Set(["id", "name"]);

/**
 * Valide que le body ne contient que les champs autorisés (CA-7, CA-27).
 */
function validateAllowedFields(body, allowedFields) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError(400, "INVALID_JSON", "Request body must be a JSON object.");
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
 * Valide les paramètres de pagination (CA-15 à CA-17).
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
 * Gestion centralisée des erreurs pour les handlers de thèmes.
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
      // Rate limiting (CA-34)
      const ip = req.socket.remoteAddress || "unknown";
      const rateCheck = rateLimiter.check(ip);
      if (!rateCheck.allowed) {
        const retryAfter = rateCheck.retryAfter || 60;
        sendJson(res, 429, {
          status: 429,
          error: "RATE_LIMIT_EXCEEDED",
          message: `Too many requests. Please retry in ${retryAfter} seconds.`,
        }, { "Retry-After": String(retryAfter) });
        return;
      }

      // Méthode non supportée (CA-35)
      if (req.method !== "GET" && req.method !== "POST") {
        sendJson(res, 405, {
          status: 405,
          error: "METHOD_NOT_ALLOWED",
          message: `HTTP method ${req.method} is not allowed on this resource.`,
        }, { Allow: "GET, POST" });
        return;
      }

      // Authentification + Autorisation (CA-32, CA-33)
      authenticate(req);
      authorize(req);

      if (req.method === "POST") {
        // CA-8 : Content-Type
        validateContentType(req);

        const body = await parseJsonBody(req);
        validateAllowedFields(body, ALLOWED_FIELDS_POST);

        if (body.name === undefined || body.name === null || String(body.name).trim() === "") {
          throw new AppError(400, "VALIDATION_ERROR", "Theme name is required.");
        }

        const theme = createTheme(db, String(body.name));
        sendJson(res, 201, theme);
        return;
      }

      // GET — Liste paginée (CA-13 à CA-19)
      // Valider le Content-Type si fourni (même sur GET)
      validateContentType(req, { allowMissing: true });

      const { page, limit } = parsePagination(url);
      const result = listThemes(db, page, limit);
      sendJson(res, 200, result);

    } catch (err) {
      handleError(res, err);
    }
  };
}

/**
 * Crée le handler de la ressource /api/v1/themes/:id.
 */
export function createThemeResourceHandler(db, config, authenticate, authorize, rateLimiter) {
  return async (req, res, url) => {
    try {
      // Rate limiting (CA-34)
      const ip = req.socket.remoteAddress || "unknown";
      const rateCheck = rateLimiter.check(ip);
      if (!rateCheck.allowed) {
        const retryAfterSeconds = rateCheck.retryAfter ?? 60;
        sendJson(
          res,
          429,
          {
            status: 429,
            error: "RATE_LIMIT_EXCEEDED",
            message: `Too many requests. Please retry in ${retryAfterSeconds} seconds.`,
          },
          { "Retry-After": String(retryAfterSeconds) }
        );
        return;
      }

      // Méthode non supportée (CA-35)
      if (!["GET", "PUT", "DELETE"].includes(req.method)) {
        sendJson(res, 405, {
          status: 405,
          error: "METHOD_NOT_ALLOWED",
          message: `HTTP method ${req.method} is not allowed on this resource.`,
        }, { Allow: "GET, PUT, DELETE" });
        return;
      }

      // Authentification + Autorisation (CA-32, CA-33)
      authenticate(req);
      authorize(req);

      // Extraction de l'ID depuis l'URL
      const id = url.pathname.split("/").pop();

      if (req.method === "GET") {
        // Valider le Content-Type si fourni (même sur GET)
        validateContentType(req, { allowMissing: true });

        const theme = getTheme(db, id);
        sendJson(res, 200, theme);
        return;
      }

      if (req.method === "PUT") {
        // CA-26 : Content-Type
        validateContentType(req);

        const body = await parseJsonBody(req);
        validateAllowedFields(body, ALLOWED_FIELDS_PUT);

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
      // Valider le Content-Type si fourni (même sur DELETE)
      validateContentType(req, { allowMissing: true });

      deleteThemeById(db, id);
      res.writeHead(204);
      res.end();

    } catch (err) {
      handleError(res, err);
    }
  };
}