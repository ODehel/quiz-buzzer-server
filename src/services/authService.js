import bcrypt from "bcrypt";
import { findByUsername } from "../repositories/userRepository.js";
import { generateToken } from "./tokenService.js";
import { AppError } from "../errors/AppError.js";
import { logInfo, logWarn } from "../utils/logger.js";

/**
 * Hash bidon pré-calculé pour les comparaisons factices.
 * Empêche les timing attacks : même si le username n'existe pas,
 * on exécute quand même un bcrypt.compare().
 */
const DUMMY_HASH = "$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8ziZCfFpOPOdHJGmjkm";

/**
 * Authentifie un utilisateur et retourne un token JWT.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ jwtSecret: string, jwtExpiration: number }} config
 * @param {string} username
 * @param {string} password
 * @param {string} ip - Adresse IP du client (pour le logging)
 * @returns {Promise<{ token: string, expires_in: number, token_type: string }>}
 * @throws {AppError} 401 INVALID_CREDENTIALS
 */
export async function authenticate(db, config, username, password, ip) {
  const user = findByUsername(db, username);

  // Comparaison bcrypt même si l'utilisateur n'existe pas (anti timing-attack)
  const hashToCompare = user ? user.USR_PASSWORD : DUMMY_HASH;
  const isPasswordValid = await bcrypt.compare(password, hashToCompare);

  if (!user || !isPasswordValid) {
    logWarn("LOGIN_FAILURE", { username, ip });
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials.");
  }

  logInfo("LOGIN_SUCCESS", { username, ip });
  return generateToken(user, config);
}