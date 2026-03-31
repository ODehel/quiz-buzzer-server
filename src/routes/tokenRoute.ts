import { AppError } from "../errors/AppError.ts";
import { authenticate } from "../services/authService.ts";
import { validateContentType } from "../middlewares/validateContentType.ts";
import { sendJson } from "../utils/sendJson.ts";
import { parseJsonBody } from "../utils/parseJsonBody.ts";
import { validateAllowedFields } from "../utils/validation.ts";
import { handleError, checkRateLimit, checkMethod } from "../utils/routeHelpers.ts";
import type { AppRequest, AppConfig, IRateLimiter, RouteHandler } from "../types/index.ts";
import { ServerResponse } from "node:http";
import Database from "better-sqlite3";

const ALLOWED_FIELDS = new Set(["username", "password"]);

/**
 * Valide le body de la requête token.
 *
 * @throws {AppError} 400 UNKNOWN_FIELDS | 400 VALIDATION_ERROR
 */
function validateBody(body: Record<string, unknown>): void {
  // Rejet des corps non-objet + champs inconnus (CA-6, CA-12)
  validateAllowedFields(body, ALLOWED_FIELDS);

  // Champs requis (CA-9, CA-10)
  const errors: string[] = [];
  if (body.username === undefined || body.username === null || String(body.username).trim() === "") {
    errors.push('Field "username" is required and must not be empty.');
  }
  if (body.password === undefined || body.password === null || String(body.password).trim() === "") {
    errors.push('Field "password" is required and must not be empty.');
  }
  if (errors.length > 0) {
    throw new AppError(400, "VALIDATION_ERROR", errors.join(" "));
  }
}

/**
 * Crée le handler de la route POST /api/v1/token.
 */
export function createTokenHandler(
  db: Database.Database,
  config: Pick<AppConfig, "jwtSecret" | "jwtExpiration">,
  rateLimiter: IRateLimiter,
): RouteHandler {
  return async (req: AppRequest, res: ServerResponse): Promise<void> => {
    try {
      // CA-16 : Méthode non supportée
      if (checkMethod(req, res, ["POST"])) return;

      // CA-13 : Rate limiting par IP
      if (checkRateLimit(req, res, rateLimiter)) return;

      // CA-7 : Content-Type
      validateContentType(req);

      // CA-11 : Parse JSON
      const body = await parseJsonBody(req);

      // CA-6, CA-9, CA-10, CA-12 : Validation
      validateBody(body as Record<string, unknown>);

      // CA-1 à CA-5, CA-8 : Authentification + Token
      const ip = req.socket.remoteAddress || "unknown";
      const result = await authenticate(db, config, (body as Record<string, unknown>).username as string, (body as Record<string, unknown>).password as string, ip);

      // 200 OK
      sendJson(res, 200, result);
    } catch (err) {
      handleError(req, res, err);
    }
  };
}
