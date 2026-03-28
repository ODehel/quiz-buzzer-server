import { readdir, unlink, stat, access, constants } from "node:fs/promises";
import { join } from "node:path";
import logger from "../config/logger.js";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

/**
 * Supprime les fichiers app-*.log plus vieux de 7 jours dans logsDir.
 * CA-29: exécuté au démarrage, avant l'ouverture des connexions.
 * CA-30: si aucun fichier à supprimer, deleted_count: 0.
 * CA-31: si suppression échoue, WARN et continue.
 * CA-15: ne pas appeler en environnement test.
 *
 * @param {string} [logsDir="logs"] - Répertoire des logs
 * @param {number} [now=Date.now()] - Timestamp courant (injectable pour tests)
 * @returns {Promise<number>} Nombre de fichiers supprimés
 */
export async function cleanOldLogs(logsDir = "logs", now = Date.now()) {
  let deletedCount = 0;

  try {
    await access(logsDir, constants.R_OK);
    const files = await readdir(logsDir);
    const logFiles = files.filter((f) => /^app[.-].*\.log$/.test(f));

    for (const file of logFiles) {
      const filePath = join(logsDir, file);
      try {
        const { mtimeMs } = await stat(filePath);
        if (now - mtimeMs > RETENTION_MS) {
          await unlink(filePath);
          deletedCount++;
        }
      } catch (err) {
        // CA-31: erreur de suppression → WARN, on continue
        logger.warn({ event: "LOGS_CLEANUP_FILE_ERROR", file, error: err.message });
      }
    }
  } catch {
    // Répertoire logs/ absent ou inaccessible — pas bloquant
  }

  // CA-29, CA-30: log du résultat
  logger.info({ event: "LOGS_CLEANUP_DONE", deleted_count: deletedCount });
  return deletedCount;
}
