import { version } from "../config/version.js";
import { sendJson } from "../utils/sendJson.js";
import { logError } from "../utils/logger.js";

/**
 * Crée le handler pour GET /api/v1/health.
 *
 * @param {Object} [deps] - Dépendances injectables (DIP pour les tests)
 * @param {function} [deps.getUptime] - Fonction retournant l'uptime en secondes
 * @param {function} [deps.getNow]    - Fonction retournant la date courante
 * @param {string}   [deps.appVersion] - Version de l'application
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void}
 */
export function createHealthHandler({
  getUptime = () => process.uptime(),
  getNow = () => new Date(),
  appVersion = version,
} = {}) {
  return (req, res) => {
    try {
      // CA-8 : Méthode non autorisée
      if (req.method !== "GET") {
        sendJson(
          res,
          405,
          {
            status: 405,
            error: "METHOD_NOT_ALLOWED",
            message: "Method Not Allowed.",
          },
          { Allow: "GET" }
        );
        return;
      }

      // CA-1 à CA-5 : Réponse nominale
      sendJson(res, 200, {
        status: "ok",
        uptime_seconds: Math.round(getUptime()),
        version: appVersion,
        timestamp: getNow().toISOString(),
      });
    } catch (err) {
      logError("INTERNAL_ERROR", { message: err.message });
      sendJson(res, 500, {
        status: 500,
        error: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred. Please try again later.",
      });
    }
  };
}
