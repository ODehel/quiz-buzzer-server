import pino from "pino";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Détermine le niveau de log selon NODE_ENV (CA-1, CA-2, CA-4).
 * @param {string} [env=process.env.NODE_ENV]
 * @returns {string}
 */
export function resolveLevel(env = process.env.NODE_ENV) {
  return env === "development" ? "debug" : "info";
}

// CA-8: niveau lisible en chaîne (pas le code numérique pino)
// Suppression des champs pid/hostname pour un format épuré conforme à la spec
export const formatters = {
  level: (label) => ({ level: label.toUpperCase() }),
  bindings: () => ({}),
};

// CA-7: horodatage ISO 8601 UTC avec millisecondes
export const timestamp = () => `,"timestamp":"${new Date().toISOString()}"`;

/**
 * Construit les streams pino selon l'environnement.
 * Séparé pour testabilité et gestion de l'erreur logs/ non-inscriptible (CA-14).
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.isDev] - Environnement development
 * @param {string} [opts.logsDir] - Répertoire des logs
 * @returns {Promise<Array>}
 */
export async function buildStreams({ isDev = false, logsDir = "logs" } = {}) {
  const streams = [];

  // Console : pretty en dev (CA-1), JSON brut en prod (CA-2)
  if (isDev) {
    const pinoPretty = await import("pino-pretty");
    streams.push({ stream: pinoPretty.default({ colorize: true }) });
  } else {
    streams.push({ stream: process.stdout });
  }

  // CA-11, CA-12: fichier rotatif — un fichier par heure dans logs/
  try {
    mkdirSync(join(logsDir), { recursive: true });
    const { default: pinoRoll } = await import("pino-roll");
    const fileStream = await pinoRoll({
      file: join(logsDir, "app"),
      frequency: "hourly",
      dateFormat: "yyyy-MM-dd'T'HH",
      mkdir: true,
    });
    streams.push({ stream: fileStream });
  } catch (err) {
    // CA-14: si logs/ non accessible, log ERROR console et continue sans fichier
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "ERROR",
      event: "LOG_FILE_INIT_ERROR",
      message: err.message,
    }));
  }

  return streams;
}

// CA-3, CA-5: singleton pino — silencieux en test, multistream sinon
const nodeEnv = process.env.NODE_ENV;
const isTest = nodeEnv === "test";

let logger;

if (isTest) {
  logger = pino({ level: "silent", enabled: false });
} else {
  const isDev = nodeEnv === "development";
  const level = resolveLevel(nodeEnv);
  const streams = await buildStreams({ isDev });
  logger = pino({ level, formatters, timestamp }, pino.multistream(streams));
}

export default logger;
