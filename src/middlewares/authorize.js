import { AppError } from "../errors/AppError.js";

/**
 * Factory retournant un middleware de vérification de rôle.
 * Paramétrable par rôle(s) autorisé(s) — Open/Closed Principle.
 *
 * @param  {...string} allowedRoles - ex: "admin", "buzzer"
 * @returns {(req: Object) => void}
 */
export function createAuthorizeMiddleware(...allowedRoles) {
  return (req) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      throw new AppError(403, "FORBIDDEN", "You do not have permission to access this resource.");
    }
  };
}