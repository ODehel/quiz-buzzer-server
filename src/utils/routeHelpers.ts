import { ServerResponse } from "node:http";
import type { AppRequest, IRateLimiter } from "../types/index.ts";
import { AppError } from "../errors/AppError.ts";
import { sendJson, sendError } from "./sendJson.ts";
import { logError } from "./logger.ts";

/**
 * Gestion centralisée des erreurs pour tous les handlers de routes.
 */
export function handleError(req: AppRequest, res: ServerResponse, err: unknown): void {
  if (err instanceof AppError) {
    sendError(res, err);
  } else {
    logError("INTERNAL_ERROR", { message: (err as Error).message });
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
 * @returns true si la requête est bloquée (réponse déjà envoyée), false sinon
 */
export function checkRateLimit(req: AppRequest, res: ServerResponse, rateLimiter: IRateLimiter): boolean {
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
 * @returns true si la méthode est refusée (réponse déjà envoyée), false sinon
 */
export function checkMethod(req: AppRequest, res: ServerResponse, allowedMethods: string[]): boolean {
  if (!allowedMethods.includes(req.method!)) {
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
