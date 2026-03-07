import jwt from "jsonwebtoken";

/**
 * Génère un token JWT pour un utilisateur authentifié.
 *
 * @param {{ USR_ID: string, USR_ROLE: string }} user
 * @param {{ jwtSecret: string, jwtExpiration: number }} config
 * @returns {{ token: string, expires_in: number, token_type: string }}
 */
export function generateToken(user, config) {
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
 *
 * @param {string} token
 * @param {string} jwtSecret
 * @returns {{ sub: string, role: string, iat: number, exp: number }}
 */
export function verifyToken(token, jwtSecret) {
  return jwt.verify(token, jwtSecret, { algorithms: ["HS256"] });
}