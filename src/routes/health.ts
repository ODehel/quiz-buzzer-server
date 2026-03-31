import { version } from "../config/version.ts";
import { sendJson } from "../utils/sendJson.ts";
import { logError } from "../utils/logger.ts";
import { AppRequest, RouteHandler } from "../types/index.ts";
import { ServerResponse } from "node:http";

interface HealthDeps {
  getUptime?: () => number;
  getNow?: () => Date;
  appVersion?: string;
}

/**
 * Crée le handler pour GET /api/v1/health.
 */
export function createHealthHandler({
  getUptime = () => process.uptime(),
  getNow = () => new Date(),
  appVersion = version,
}: HealthDeps = {}): RouteHandler {
  return (req: AppRequest, res: ServerResponse): void => {
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
      logError("INTERNAL_ERROR", { message: (err as Error).message });
      sendJson(res, 500, {
        status: 500,
        error: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred. Please try again later.",
      });
    }
  };
}
