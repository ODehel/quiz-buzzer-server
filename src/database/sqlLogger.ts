import Database from "better-sqlite3";
import logger from "../config/logger.ts";
import { getCorrelationId } from "../utils/correlationStore.ts";

/**
 * Colonnes contenant des données sensibles (CA-28).
 * Les valeurs correspondantes sont masquées dans les logs SQL.
 */
const SENSITIVE_COLUMNS: Set<string> = new Set(["USR_PASSWORD"]);

type SqlParam = string | number | null | Buffer;

/**
 * Masque les paramètres sensibles dans les logs SQL (CA-28).
 * Détecte les colonnes sensibles dans la requête et remplace
 * les paramètres correspondants par "[REDACTED]".
 */
export function redactSensitiveParams(query: string, params: SqlParam[]): (SqlParam | string)[] {
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
 */
export function wrapDatabaseWithLogging(db: Database.Database): Database.Database {
  if (!logger.isLevelEnabled("debug")) {
    return db;
  }

  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return function (sql: string) {
          const stmt = target.prepare(sql);
          return wrapStatement(stmt, sql);
        };
      }
      return (target as unknown as Record<string | symbol, unknown>)[prop];
    },
  }) as Database.Database;
}

/**
 * Wraps a better-sqlite3 Statement to log execution at DEBUG level.
 */
function wrapStatement(stmt: Database.Statement, sql: string): Database.Statement {
  return new Proxy(stmt, {
    get(target, prop) {
      if (["run", "get", "all"].includes(prop as string)) {
        return function (...args: SqlParam[]) {
          const start = Date.now();
          const result = (target as unknown as Record<string | symbol, (...a: SqlParam[]) => unknown>)[prop](...args);
          const durationMs = Date.now() - start;
          const correlationId = getCorrelationId();

          const logEntry: Record<string, unknown> = {
            event: "SQL_QUERY",
            query: sql,
            params: redactSensitiveParams(sql, args.length === 1 && Array.isArray(args[0]) ? args[0] as SqlParam[] : args),
            duration_ms: durationMs,
          };

          if (correlationId) {
            logEntry.correlation_id = correlationId;
          }

          logger.debug(logEntry);
          return result;
        };
      }
      return (target as unknown as Record<string | symbol, unknown>)[prop];
    },
  }) as Database.Statement;
}
