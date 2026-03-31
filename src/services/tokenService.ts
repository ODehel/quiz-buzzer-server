import jwt from "jsonwebtoken";
import { AppConfig, TokenResult, JwtPayload, UserRow } from "../types/index.ts";

/**
 * Génère un token JWT pour un utilisateur authentifié.
 */
export function generateToken(
  user: Pick<UserRow, "USR_ID" | "USR_ROLE">,
  config: Pick<AppConfig, "jwtSecret" | "jwtExpiration">,
): TokenResult {
  const payload = {
    sub: user.USR_ID,
    role: user.USR_ROLE,
  };

  const token = jwt.sign(payload, config.jwtSecret, {
    algorithm: "HS256",
    expiresIn: config.jwtExpiration,
  });

  return {
    token,
    expires_in: config.jwtExpiration,
    token_type: "Bearer",
  };
}

/**
 * Vérifie et décode un token JWT.
 */
export function verifyToken(token: string, jwtSecret: string): JwtPayload {
  return jwt.verify(token, jwtSecret, { algorithms: ["HS256"] }) as JwtPayload;
}
