import "dotenv/config";

import type { AppConfig } from "../types/index.ts";

/**
 * Charge et valide les variables d'environnement applicatives.
 *
 * @param {Object} [source=process.env] - injectable pour les tests (DIP)
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): AppConfig {
  const jwtSecret = source.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be defined and at least 32 characters long.");
  }

  return {
    jwtSecret,
    jwtExpiration: parseInt(source.JWT_EXPIRATION!, 10) || 3600,
    port: parseInt(source.PORT!, 10) || 3000,
    serverBaseUrl: source.SERVER_BASE_URL || "",
  };
}
