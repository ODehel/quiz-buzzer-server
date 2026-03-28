import logger from "../config/logger.js";

/**
 * Wraps an HTTP request handler to log incoming requests (CA-20) and
 * outgoing responses (CA-21) with correlation_id.
 *
 * @param {Function} handler - The next request handler
 * @returns {Function} Wrapped handler
 */
export function withHttpLogger(handler) {
  return function httpLoggerHandler(req, res, ...args) {
    const startedAt = Date.now();

    // CA-20: log requête entrante
    const requestLog = {
      event: "HTTP_REQUEST",
      method: req.method,
      url: req.url,
      ip: req.socket?.remoteAddress || "unknown",
      correlation_id: req.correlationId,
    };

    // CA-22: body en DEBUG uniquement (loggué après parsing si disponible)
    if (logger.isLevelEnabled("debug") && req.body) {
      requestLog.body = req.body;
    }

    logger.info(requestLog);

    // CA-21: log réponse sortante via interception de res.end
    const originalEnd = res.end.bind(res);
    res.end = function (...endArgs) {
      logger.info({
        event: "HTTP_RESPONSE",
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
        correlation_id: req.correlationId,
      });
      return originalEnd(...endArgs);
    };

    handler(req, res, ...args);
  };
}
