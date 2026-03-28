import { v7 as uuidv7 } from "uuid";
import { runWithCorrelationId } from "../utils/correlationStore.js";

/**
 * Wraps an HTTP request handler to generate a UUIDv7 correlation_id (CA-16).
 * Sets req.correlationId (CA-17), the X-Correlation-Id response header (CA-18),
 * and propagates via AsyncLocalStorage for SQL logging (CA-27).
 *
 * @param {Function} handler - The next request handler
 * @returns {Function} Wrapped handler
 */
export function withCorrelationId(handler) {
  return function correlationIdHandler(req, res, ...args) {
    req.correlationId = uuidv7();
    res.setHeader("X-Correlation-Id", req.correlationId);
    runWithCorrelationId(req.correlationId, () => handler(req, res, ...args));
  };
}
