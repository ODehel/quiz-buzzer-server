import { verifyToken } from "../services/tokenService.ts";
import { AppError } from "../errors/AppError.ts";
import type { AppRequest, AuthMiddleware } from "../types/index.ts";

/**
 * Middleware d'authentification Bearer token.
 * Injecte `req.user` ({ sub, role, iat, exp }) si le token est valide.
 */
export function createAuthenticateMiddleware(jwtSecret: string): AuthMiddleware {
  return (req: AppRequest): void => {
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
