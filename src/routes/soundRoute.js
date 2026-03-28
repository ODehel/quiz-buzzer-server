import { AppError } from "../errors/AppError.js";
import { sendJson } from "../utils/sendJson.js";
import { parseSoundFormData } from "../middlewares/soundUpload.js";
import {
  createSound,
  getSound,
  listSounds,
  deleteSoundById,
} from "../services/soundService.js";
import { parsePagination } from "../utils/validation.js";
import { handleError, checkRateLimit, checkMethod } from "../utils/routeHelpers.js";

/**
 * Handler de la collection /api/v1/sounds (GET list, POST upload).
 */
export function createSoundsCollectionHandler(db, config, authenticate, authorize, rateLimiter, uploadsDir) {
  return async (req, res, url) => {
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
export function createSoundResourceHandler(db, config, authenticate, authorize, rateLimiter, uploadsDir) {
  return async (req, res, url) => {
    try {
      if (checkRateLimit(req, res, rateLimiter)) return;
      if (checkMethod(req, res, ["GET", "DELETE"])) return;

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
      handleError(req, res, err);
    }
  };
}
