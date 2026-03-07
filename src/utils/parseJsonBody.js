import { AppError } from "../errors/AppError.js";

/**
 * Lit et parse le body JSON d'une requête.
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<Object>}
 * @throws {AppError} 400 INVALID_JSON
 */
export function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AppError(400, "INVALID_JSON", "Request body must be valid JSON."));
      }
    });
    req.on("error", (err) => reject(err));
  });
}