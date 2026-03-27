import { AppError } from "../errors/AppError.js";
import { sendJson, sendError } from "../utils/sendJson.js";
import { logError } from "../utils/logger.js";
import { createUploadMiddleware } from "../middlewares/upload.js";
import {
  uploadSound,
  listSounds,
  getSound,
  deleteSound,
  parsePagination,
} from "../services/soundService.js";

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
 * Wraps multer single-file parsing in a Promise.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @returns {Promise<void>}
 */
function parseMultipart(req, res) {
  return new Promise((resolve, reject) => {
    const upload = createUploadMiddleware();
    upload.single("file")(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Handler for GET /api/v1/sounds and POST /api/v1/sounds.
 */
export function createSoundsCollectionHandler(db, config, authenticate, authorize, rateLimiter) {
  return async (req, res, url) => {
    try {
      const ip = req.socket.remoteAddress || "unknown";
      const rateCheck = rateLimiter.check(ip);
      if (!rateCheck.allowed) {
        const retryAfter = rateCheck.retryAfter ?? 60;
        sendJson(res, 429, {
          status: 429,
          error: "RATE_LIMIT_EXCEEDED",
          message: `Too many requests. Please retry in ${retryAfter} seconds.`,
        }, { "Retry-After": String(retryAfter) });
        return;
      }

      if (req.method !== "GET" && req.method !== "POST") {
        sendJson(res, 405, {
          status: 405,
          error: "METHOD_NOT_ALLOWED",
          message: `HTTP method ${req.method} is not allowed on this resource.`,
        }, { Allow: "GET, POST" });
        return;
      }

      authenticate(req);
      authorize(req);

      if (req.method === "GET") {
        const { page, limit } = parsePagination(url);
        sendJson(res, 200, listSounds(db, page, limit));
        return;
      }

      // POST: multipart upload
      const contentType = req.headers["content-type"] || "";
      if (!contentType.includes("multipart/form-data")) {
        sendJson(res, 415, {
          status: 415,
          error: "UNSUPPORTED_MEDIA_TYPE",
          message: "Request must be multipart/form-data.",
        });
        return;
      }

      let multerErr = null;
      try {
        await parseMultipart(req, res);
      } catch (err) {
        multerErr = err;
      }

      if (multerErr) {
        if (multerErr.code === "LIMIT_FILE_SIZE") {
          sendJson(res, 413, {
            status: 413,
            error: "FILE_TOO_LARGE",
            message: "File size exceeds the 10 MB limit.",
          });
        } else {
          handleError(res, multerErr);
        }
        return;
      }

      if (!req.file) {
        sendJson(res, 400, {
          status: 400,
          error: "VALIDATION_ERROR",
          message: "No file provided.",
        });
        return;
      }

      const sound = await uploadSound(db, {
        name: req.body?.name,
        mimetype: req.file.mimetype,
        buffer: req.file.buffer,
      });
      sendJson(res, 201, sound);

    } catch (err) {
      handleError(res, err);
    }
  };
}

/**
 * Handler for GET /api/v1/sounds/:id and DELETE /api/v1/sounds/:id.
 */
export function createSoundResourceHandler(db, config, authenticate, authorize, rateLimiter) {
  return async (req, res, url) => {
    try {
      const ip = req.socket.remoteAddress || "unknown";
      const rateCheck = rateLimiter.check(ip);
      if (!rateCheck.allowed) {
        const retryAfter = rateCheck.retryAfter ?? 60;
        sendJson(res, 429, {
          status: 429,
          error: "RATE_LIMIT_EXCEEDED",
          message: `Too many requests. Please retry in ${retryAfter} seconds.`,
        }, { "Retry-After": String(retryAfter) });
        return;
      }

      if (req.method !== "GET" && req.method !== "DELETE") {
        sendJson(res, 405, {
          status: 405,
          error: "METHOD_NOT_ALLOWED",
          message: `HTTP method ${req.method} is not allowed on this resource.`,
        }, { Allow: "GET, DELETE" });
        return;
      }

      authenticate(req);
      authorize(req);

      const match = url.pathname.match(/^\/api\/v1\/sounds\/([^/]+)$/);
      const id = match[1];

      if (req.method === "GET") {
        sendJson(res, 200, getSound(db, id));
        return;
      }

      // DELETE
      await deleteSound(db, id);
      res.writeHead(204);
      res.end();

    } catch (err) {
      handleError(res, err);
    }
  };
}
