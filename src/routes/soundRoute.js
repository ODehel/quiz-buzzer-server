import { AppError } from "../errors/AppError.js";
import { sendJson, sendError } from "../utils/sendJson.js";
import { logError } from "../utils/logger.js";
import { parseSoundFormData } from "../middlewares/soundUpload.js";
import {
  createSound,
  getSound,
  listSounds,
  deleteSoundById,
} from "../services/soundService.js";

/**
 * Valide les paramètres de pagination (CA-12, CA-13).
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
 * Gestion centralisée des erreurs.
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
 * Handler de la collection /api/v1/sounds (GET list, POST upload).
 */
export function createSoundsCollectionHandler(db, config, authenticate, authorize, rateLimiter, uploadsDir) {
  return async (req, res, url) => {
    try {
      // Rate limiting (CA-33)
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

      // CA-34: Méthode non supportée
      if (req.method !== "GET" && req.method !== "POST") {
        sendJson(res, 405, {
          status: 405,
          error: "METHOD_NOT_ALLOWED",
          message: `HTTP method ${req.method} is not allowed on this resource.`,
        }, { Allow: "GET, POST" });
        return;
      }

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
      handleError(res, err);
    }
  };
}

/**
 * Handler de la ressource /api/v1/sounds/:id (GET, DELETE).
 */
export function createSoundResourceHandler(db, config, authenticate, authorize, rateLimiter, uploadsDir) {
  return async (req, res, url) => {
    try {
      // Rate limiting (CA-33)
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

      // CA-34: Méthode non supportée
      if (req.method !== "GET" && req.method !== "DELETE") {
        sendJson(res, 405, {
          status: 405,
          error: "METHOD_NOT_ALLOWED",
          message: `HTTP method ${req.method} is not allowed on this resource.`,
        }, { Allow: "GET, DELETE" });
        return;
      }

      // CA-31, CA-32: Authentification + Autorisation
      authenticate(req);
      authorize(req);

      const id = url.pathname.split("/").pop();

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
      handleError(res, err);
    }
  };
}
