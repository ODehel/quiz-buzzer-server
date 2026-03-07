/**
 * Construit un log JSON structuré.
 *
 * @param {string} level - INFO | WARN | ERROR
 * @param {string} event - Nom de l'événement
 * @param {Object} data  - Données contextuelles
 * @returns {string} JSON stringifié
 */
function formatLog(level, event, data) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...data,
  });
}

/** @param {string} event @param {Object} data */
export function logInfo(event, data) {
  console.log(formatLog("INFO", event, data));
}

/** @param {string} event @param {Object} data */
export function logWarn(event, data) {
  console.warn(formatLog("WARN", event, data));
}

/** @param {string} event @param {Object} data */
export function logError(event, data) {
  console.error(formatLog("ERROR", event, data));
}