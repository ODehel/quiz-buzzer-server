import logger from "../config/logger.js";
import { getCorrelationId } from "../utils/correlationStore.js";

/**
 * Colonnes contenant des données sensibles (CA-28).
 * Les valeurs correspondantes sont masquées dans les logs SQL.
 */
const SENSITIVE_COLUMNS = new Set(["USR_PASSWORD"]);

/**
 * Masque les paramètres sensibles dans les logs SQL (CA-28).
 * Détecte les colonnes sensibles dans la requête et remplace
 * les paramètres correspondants par "[REDACTED]".
 *
 * @param {string} query - Requête SQL
 * @param {Array} params - Paramètres de la requête
 * @returns {Array} Paramètres avec valeurs sensibles masquées
 */
export function redactSensitiveParams(query, params) {
  if (!params || params.length === 0) return params;

  // Trouver les positions des placeholders dans la requête
  const upperQuery = query.toUpperCase();
  const hasSensitive = [...SENSITIVE_COLUMNS].some((col) =>
    upperQuery.includes(col)
  );

  if (!hasSensitive) return params;

  // Pour les requêtes INSERT, trouver les positions des colonnes sensibles
  // Pattern: INSERT INTO table (col1, col2, ...) VALUES (?, ?, ...)
  const insertMatch = upperQuery.match(
    /INSERT\s+INTO\s+\S+\s*\(([^)]+)\)/
  );
  if (insertMatch) {
    const columns = insertMatch[1].split(",").map((c) => c.trim());
    return params.map((p, i) =>
      SENSITIVE_COLUMNS.has(columns[i]) ? "[REDACTED]" : p
    );
  }

  // Pour les requêtes UPDATE: SET col = ?, col2 = ?
  const setMatch = upperQuery.match(/SET\s+(.+?)(?:\s+WHERE|$)/);
  if (setMatch) {
    const setClauses = setMatch[1].split(",").map((c) => c.trim());
    const setColumns = setClauses.map((c) => c.split(/\s*=\s*/)[0].trim());
    // Les paramètres SET sont dans l'ordre des colonnes, suivis des paramètres WHERE
    return params.map((p, i) =>
      i < setColumns.length && SENSITIVE_COLUMNS.has(setColumns[i])
        ? "[REDACTED]"
        : p
    );
  }

  return params;
}

/**
 * Wraps a better-sqlite3 database instance to log SQL queries at DEBUG level (CA-27).
 * En dehors du niveau DEBUG, le proxy passe directement sans overhead.
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {import("better-sqlite3").Database} Proxied database
 */
export function wrapDatabaseWithLogging(db) {
  if (!logger.isLevelEnabled("debug")) {
    return db;
  }

  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return function (sql) {
          const stmt = target.prepare(sql);
          return wrapStatement(stmt, sql);
        };
      }
      return target[prop];
    },
  });
}

/**
 * Wraps a better-sqlite3 Statement to log execution at DEBUG level.
 */
function wrapStatement(stmt, sql) {
  return new Proxy(stmt, {
    get(target, prop) {
      if (["run", "get", "all"].includes(prop)) {
        return function (...args) {
          const start = Date.now();
          const result = target[prop](...args);
          const durationMs = Date.now() - start;
          const correlationId = getCorrelationId();

          const logEntry = {
            event: "SQL_QUERY",
            query: sql,
            params: redactSensitiveParams(sql, args.length === 1 && Array.isArray(args[0]) ? args[0] : args),
            duration_ms: durationMs,
          };

          if (correlationId) {
            logEntry.correlation_id = correlationId;
          }

          logger.debug(logEntry);
          return result;
        };
      }
      return target[prop];
    },
  });
}
