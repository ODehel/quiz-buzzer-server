import { ServerResponse } from "node:http";
import type { AppRequest } from "../types/index.ts";
import { AppError } from "../errors/AppError.ts";

/**
 * Envoie une réponse JSON.
 */
export function sendJson(res: ServerResponse, statusCode: number, body: unknown, headers: Record<string, string> = {}): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    ...headers,
  });
  res.end(json);
}

/**
 * Envoie une réponse d'erreur AppError.
 */
export function sendError(res: ServerResponse, err: AppError, headers: Record<string, string> = {}, req: AppRequest | null = null): void {
  const body: Record<string, unknown> = err.toJSON();
  // CA-19: inclure correlation_id dans le body des erreurs 500
  if (err.status === 500 && req?.correlationId) {
    body.correlation_id = req.correlationId;
  }
  sendJson(res, err.status, body, headers);
}
