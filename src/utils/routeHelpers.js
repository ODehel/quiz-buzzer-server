import { AppError } from "../errors/AppError.js";
import { sendJson, sendError } from "./sendJson.js";
import { logError } from "./logger.js";

/**
 * Gestion centralisée des erreurs pour tous les handlers de routes.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {unknown} err
 */
export function handleError(req, res, err) {
  if (err instanceof AppError) {
    sendError(res, err);
  } else {
    logError("INTERNAL_ERROR", { message: err.message });
    sendJson(res, 500, {
      status: 500,
      error: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred. Please try again later.",
      correlation_id: req.correlationId,
    });
  }
}

/**
 * Vérifie le rate limiting et envoie une 429 si dépassé.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {import("../middlewares/rateLimiter.js").RateLimiter} rateLimiter
 * @returns {boolean} true si la requête est bloquée (réponse déjà envoyée), false sinon
 */
export function checkRateLimit(req, res, rateLimiter) {
  const ip = req.socket.remoteAddress || "unknown";
  const rateCheck = rateLimiter.check(ip);
  if (!rateCheck.allowed) {
    const retryAfter = rateCheck.retryAfter ?? 60;
    sendJson(
      res,
      429,
      {
        status: 429,
        error: "RATE_LIMIT_EXCEEDED",
        message: `Too many requests. Please retry in ${retryAfter} seconds.`,
      },
      { "Retry-After": String(retryAfter) }
    );
    return true;
  }
  return false;
}

/**
 * Vérifie que la méthode HTTP est autorisée et envoie une 405 sinon.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {string[]} allowedMethods - Liste des méthodes autorisées (ex: ["GET", "POST"])
 * @returns {boolean} true si la méthode est refusée (réponse déjà envoyée), false sinon
 */
export function checkMethod(req, res, allowedMethods) {
  if (!allowedMethods.includes(req.method)) {
    sendJson(
      res,
      405,
      {
        status: 405,
        error: "METHOD_NOT_ALLOWED",
        message: `HTTP method ${req.method} is not allowed on this resource.`,
      },
      { Allow: allowedMethods.join(", ") }
    );
    return true;
  }
  return false;
}
