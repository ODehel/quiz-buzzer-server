import "dotenv/config";

/**
 * Charge et valide les variables d'environnement applicatives.
 *
 * @param {Object} [source=process.env] - injectable pour les tests (DIP)
 * @returns {{ jwtSecret: string, jwtExpiration: number, port: number, serverBaseUrl: string }}
 */
export function loadEnv(source = process.env) {
  const jwtSecret = source.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be defined and at least 32 characters long.");
  }

  return {
    jwtSecret,
    jwtExpiration: parseInt(source.JWT_EXPIRATION, 10) || 3600,
    port: parseInt(source.PORT, 10) || 3000,
    serverBaseUrl: source.SERVER_BASE_URL || "",
  };
}
