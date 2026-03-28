import logger from "../config/logger.js";

/** @param {string} event @param {Object} data */
export function logInfo(event, data) {
  logger.info({ event, ...data });
}

/** @param {string} event @param {Object} data */
export function logWarn(event, data) {
  logger.warn({ event, ...data });
}

/** @param {string} event @param {Object} data */
export function logError(event, data) {
  logger.error({ event, ...data });
}
