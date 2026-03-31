import { v7 as uuidv7 } from "uuid";
import { runWithCorrelationId } from "../utils/correlationStore.ts";
import { ServerResponse } from "node:http";
import type { AppRequest } from "../types/index.ts";

/**
 * Wraps an HTTP request handler to generate a UUIDv7 correlation_id (CA-16).
 * Sets req.correlationId (CA-17), the X-Correlation-Id response header (CA-18),
 * and propagates via AsyncLocalStorage for SQL logging (CA-27).
 */
export function withCorrelationId(
  handler: (req: AppRequest, res: ServerResponse, ...args: unknown[]) => void
): (req: AppRequest, res: ServerResponse, ...args: unknown[]) => void {
  return function correlationIdHandler(req: AppRequest, res: ServerResponse, ...args: unknown[]): void {
    req.correlationId = uuidv7();
    res.setHeader("X-Correlation-Id", req.correlationId);
    runWithCorrelationId(req.correlationId, () => handler(req, res, ...args));
  };
}
