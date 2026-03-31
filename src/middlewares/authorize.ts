import { AppError } from "../errors/AppError.ts";
import { AppRequest, AuthorizeMiddleware } from "../types/index.ts";

/**
 * Factory retournant un middleware de vérification de rôle.
 * Paramétrable par rôle(s) autorisé(s) — Open/Closed Principle.
 */
export function createAuthorizeMiddleware(...allowedRoles: string[]): AuthorizeMiddleware {
  return (req: AppRequest): void => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      throw new AppError(403, "FORBIDDEN", "You do not have permission to access this resource.");
    }
  };
}
