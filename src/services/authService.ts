import bcrypt from "bcrypt";
import { findByUsername } from "../repositories/userRepository.ts";
import { generateToken } from "./tokenService.ts";
import { AppError } from "../errors/AppError.ts";
import { logInfo, logWarn } from "../utils/logger.ts";
import Database from "better-sqlite3";
import { AppConfig, TokenResult } from "../types/index.ts";

/**
 * Hash bidon pré-calculé pour les comparaisons factices.
 * Empêche les timing attacks : même si le username n'existe pas,
 * on exécute quand même un bcrypt.compare().
 */
const DUMMY_HASH = "$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8ziZCfFpOPOdHJGmjkm";

/**
 * Authentifie un utilisateur et retourne un token JWT.
 *
 * @param db
 * @param config
 * @param username
 * @param password
 * @param ip - Adresse IP du client (pour le logging)
 * @returns Token JWT
 * @throws {AppError} 401 INVALID_CREDENTIALS
 */
export async function authenticate(
  db: Database.Database,
  config: Pick<AppConfig, "jwtSecret" | "jwtExpiration">,
  username: string,
  password: string,
  ip: string,
): Promise<TokenResult> {
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
