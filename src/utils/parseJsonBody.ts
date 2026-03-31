import { IncomingMessage } from "node:http";
import { AppError } from "../errors/AppError.ts";

/**
 * Lit et parse le body JSON d'une requête.
 *
 * @throws {AppError} 400 INVALID_JSON
 */
export function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AppError(400, "INVALID_JSON", "Request body must be valid JSON."));
      }
    });
    req.on("error", (err: Error) => reject(err));
  });
}
