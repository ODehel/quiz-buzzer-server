import { AppError } from "../errors/AppError.js";
import { validateContentType } from "../middlewares/validateContentType.js";
import { sendJson } from "../utils/sendJson.js";
import { parseJsonBody } from "../utils/parseJsonBody.js";
import {
  createQuestion,
  createQuestions,
  getQuestion,
  listQuestions,
  updateQuestionById,
  patchQuestionById,
  deleteQuestionById,
  parseFilters,
  validateUuid,
  toApiFormat,
} from "../services/questionService.js";
import { parsePagination } from "../utils/validation.js";
import { handleError, checkRateLimit, checkMethod } from "../utils/routeHelpers.js";
import { countQuizzesByQuestion } from "../repositories/quizRepository.js";
import { parseMultipartFormData, isValidMediaType } from "../middlewares/upload.js";
import { uploadMedia, deleteMedia } from "../services/mediaService.js";

/**
 * Crée le handler de la collection /api/v1/questions.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ jwtSecret: string }} config
 * @param {Function} authenticate
 * @param {Function} authorize
 * @param {import("../middlewares/rateLimiter.js").RateLimiter} rateLimiter
 */
export function createQuestionsCollectionHandler(db, config, authenticate, authorize, rateLimiter) {
  return async (req, res, url) => {
    try {
      if (checkRateLimit(req, res, rateLimiter)) return;
      if (checkMethod(req, res, ["GET", "POST"])) return;

      // Authentification + Autorisation (CA-80, CA-81)
      authenticate(req);
      authorize(req);

      if (req.method === "POST") {
        // CA-20: Content-Type
        validateContentType(req);

        const body = await parseJsonBody(req);
        const question = createQuestion(db, body);
        sendJson(res, 201, question);
        return;
      }

      // GET — Liste paginée avec filtrage (CA-26 à CA-44)
      const { page, limit } = parsePagination(url);
      const filters = parseFilters(url, db);
      const result = listQuestions(db, filters, page, limit);
      sendJson(res, 200, result);

    } catch (err) {
      handleError(req, res, err);
    }
  };
}

/**
 * Crée le handler de la ressource /api/v1/questions/:id.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ jwtSecret: string }} config
 * @param {Function} authenticate
 * @param {Function} authorize
 * @param {import("../middlewares/rateLimiter.js").RateLimiter} rateLimiter
 * @param {string} [uploadsDir=""] - Base directory for uploads (optional, for CA-24 media deletion)
 */
export function createQuestionResourceHandler(db, config, authenticate, authorize, rateLimiter, uploadsDir = "") {
  return async (req, res, url) => {
    try {
      if (checkRateLimit(req, res, rateLimiter)) return;
      if (checkMethod(req, res, ["GET", "PUT", "PATCH", "DELETE"])) return;

      // Authentification + Autorisation (CA-80, CA-81)
      authenticate(req);
      authorize(req);

      const id = url.pathname.split("/").pop();

      if (req.method === "GET") {
        const question = getQuestion(db, id);
        sendJson(res, 200, question);
        return;
      }

      if (req.method === "PUT") {
        // CA-53: Content-Type
        validateContentType(req);
        const body = await parseJsonBody(req);
        const question = updateQuestionById(db, id, body);
        sendJson(res, 200, question);
        return;
      }

      if (req.method === "PATCH") {
        // CA-72: Content-Type
        validateContentType(req);
        const body = await parseJsonBody(req);
        // CA-24: patchQuestionById now handles media file deletion when image_path or audio_path is set to null
        const question = await patchQuestionById(db, id, body, uploadsDir);
        sendJson(res, 200, question);
        return;
      }

      // CA-36 : Garde — la question ne peut pas être supprimée si elle appartient à un quiz
      const quizCount = countQuizzesByQuestion(db, id);
      if (quizCount > 0) {
        throw new AppError(
          409,
          "QUESTION_IN_QUIZ",
          "Cannot delete this question: it belongs to one or more quizzes."
        );
      }

      // DELETE (CA-74 à CA-77)
      deleteQuestionById(db, id);
      res.writeHead(204);
      res.end();

    } catch (err) {
      handleError(req, res, err);
    }
  };
}

/**
 * Crée le handler pour POST /api/v1/questions/bulk.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ jwtSecret: string }} config
 * @param {Function} authenticate
 * @param {Function} authorize
 * @param {import("../middlewares/rateLimiter.js").RateLimiter} rateLimiter
 */
export function createQuestionsBulkHandler(db, config, authenticate, authorize, rateLimiter) {
  return async (req, res) => {
    try {
      if (checkRateLimit(req, res, rateLimiter)) return;
      if (checkMethod(req, res, ["POST"])) return;

      // Authentification + Autorisation
      authenticate(req);
      authorize(req);

      // Content-Type
      validateContentType(req);

      const body = await parseJsonBody(req);
      const result = createQuestions(db, body);
      sendJson(res, 201, result);

    } catch (err) {
      handleError(req, res, err);
    }
  };
}

/**
 * Crée le handler pour POST /api/v1/questions/:id/media (upload).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ jwtSecret: string }} config
 * @param {Function} authenticate
 * @param {Function} authorize
 * @param {import("../middlewares/rateLimiter.js").RateLimiter} rateLimiter
 * @param {string} uploadsDir - Base directory for uploads
 */
export function createMediaUploadHandler(db, config, authenticate, authorize, rateLimiter, uploadsDir) {
  return async (req, res, url) => {
    try {
      if (checkRateLimit(req, res, rateLimiter)) return;
      if (checkMethod(req, res, ["POST"])) return;

      // Authenticate + Authorize (CA-25, CA-26)
      authenticate(req);
      authorize(req);

      // Validate Content-Type is multipart/form-data (CA-14)
      const contentType = req.headers["content-type"] || "";
      if (!contentType.includes("multipart/form-data")) {
        throw new AppError(
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          "Content-Type must be 'multipart/form-data'."
        );
      }

      // Parse multipart form data (CA-6, CA-7, CA-8, CA-9, CA-10, CA-11)
      const { type: mediaType, file } = await parseMultipartFormData(req);

      // Extract and validate question ID (CA-13)
      const questionId = url.pathname.match(/\/api\/v1\/questions\/([^/]+)\/media$/)?.[1];
      if (!questionId) {
        throw new AppError(400, "INVALID_UUID", "The provided ID is not a valid UUID.");
      }
      validateUuid(questionId);

      // Upload media and return updated question (CA-1, CA-2, CA-3, CA-4, CA-5)
      const questionRow = await uploadMedia(db, questionId, mediaType, file, uploadsDir);
      const question = toApiFormat(questionRow);
      sendJson(res, 200, question);

    } catch (err) {
      handleError(req, res, err);
    }
  };
}

/**
 * Crée le handler pour DELETE /api/v1/questions/:id/media/:type (delete).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ jwtSecret: string }} config
 * @param {Function} authenticate
 * @param {Function} authorize
 * @param {import("../middlewares/rateLimiter.js").RateLimiter} rateLimiter
 * @param {string} uploadsDir - Base directory for uploads
 */
export function createMediaDeleteHandler(db, config, authenticate, authorize, rateLimiter, uploadsDir) {
  return async (req, res, url) => {
    try {
      if (checkRateLimit(req, res, rateLimiter)) return;
      if (checkMethod(req, res, ["DELETE"])) return;

      // Authenticate + Authorize (CA-25, CA-26)
      authenticate(req);
      authorize(req);

      // Extract question ID and media type from URL (CA-21)
      const match = url.pathname.match(/^\/api\/v1\/questions\/([^/]+)\/media\/([^/]+)$/);
      if (!match) {
        throw new AppError(400, "INVALID_UUID", "The provided ID is not a valid UUID.");
      }

      const [, questionId, mediaType] = match;

      // Validate UUID format (CA-21)
      validateUuid(questionId);

      // Validate media type (CA-19)
      if (!isValidMediaType(mediaType)) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "The media type must be either 'image' or 'audio'."
        );
      }

      // Delete media (CA-15, CA-16, CA-17, CA-18, CA-20)
      await deleteMedia(db, questionId, mediaType, uploadsDir);
      res.writeHead(204);
      res.end();

    } catch (err) {
      handleError(req, res, err);
    }
  };
}
