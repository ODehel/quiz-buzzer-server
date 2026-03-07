import { verifyToken } from "../services/tokenService.js";
import { AppError } from "../errors/AppError.js";

/**
 * Middleware d'authentification Bearer token.
 * Injecte `req.user` ({ sub, role, iat, exp }) si le token est valide.
 *
 * @param {string} jwtSecret
 * @returns {(req: Object) => void}
 */
export function createAuthenticateMiddleware(jwtSecret) {
  return (req) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new AppError(401, "UNAUTHORIZED", "Missing or invalid Authorization header.");
    }

    const token = authHeader.slice(7);

    try {
      req.user = verifyToken(token, jwtSecret);
    } catch {
      throw new AppError(401, "UNAUTHORIZED", "Invalid or expired token.");
    }
  };
}