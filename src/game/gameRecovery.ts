/**
 * Reprise de partie interrompue au démarrage du serveur (US-019).
 *
 * Ce module s'exécute une seule fois au démarrage, avant que le serveur
 * HTTP et WebSocket accepte des connexions (CA-8).
 *
 * Responsabilité unique (SRP) : détecter une partie en statut intermédiaire
 * et la ramener en OPEN avec le bon index de question.
 */

import Database from "better-sqlite3";
import { GameStatus } from "../types/index.ts";
import { logInfo, logError } from "../utils/logger.ts";

/** Statuts intermédiaires nécessitant une reprise. */
const INTERMEDIATE_STATUSES: GameStatus[] = [
  "QUESTION_TITLE",
  "QUESTION_OPEN",
  "QUESTION_BUZZED",
  "QUESTION_CLOSED",
];

interface RecoveryGameRow {
  GAM_ID: string;
  GAM_STATUS: GameStatus;
  GAM_CURRENT_QUESTION_INDEX: number;
}

/**
 * Détecte et restaure une partie interrompue par un crash serveur.
 *
 * - Si aucune partie n'est en statut intermédiaire -> log GAME_RECOVERY_NONE (CA-1, CA-22)
 * - Si une partie est en QUESTION_CLOSED -> index + 1, status = OPEN (CA-3)
 * - Si une partie est en QUESTION_TITLE/OPEN/BUZZED -> même index, status = OPEN (CA-3, CA-4)
 * - Mise à jour atomique dans une transaction (CA-9)
 */
export function recoverInterruptedGame(db: Database.Database): void {
  let game: RecoveryGameRow | undefined;

  try {
    // CA-1: Détecter une partie en statut intermédiaire
    game = db.prepare(
      `SELECT GAM_ID, GAM_STATUS, GAM_CURRENT_QUESTION_INDEX
       FROM T_GAME_GAM
       WHERE GAM_STATUS IN ('QUESTION_TITLE', 'QUESTION_OPEN', 'QUESTION_BUZZED', 'QUESTION_CLOSED')
       LIMIT 1`
    ).get() as RecoveryGameRow | undefined;
  } catch (error: unknown) {
    // CA-9, CA-23: Échec de lecture -> log ERROR et continuer le démarrage
    logError("GAME_RECOVERY_FAILED", {
      game_id: null,
      error: (error as Error).message,
    });
    return;
  }

  if (!game) {
    // CA-1, CA-22: Aucune partie à reprendre
    logInfo("GAME_RECOVERY_NONE", {});
    return;
  }

  const oldStatus = game.GAM_STATUS;

  // CA-3: Calculer le nouvel index
  // QUESTION_CLOSED -> la question affichée était terminée, on passe à la suivante
  // Autres -> la question était en cours, on la rejoue
  const newQuestionIndex = oldStatus === "QUESTION_CLOSED"
    ? game.GAM_CURRENT_QUESTION_INDEX + 1
    : game.GAM_CURRENT_QUESTION_INDEX;

  // CA-9: Mise à jour atomique dans une transaction
  try {
    const update = db.transaction(() => {
      db.prepare(
        `UPDATE T_GAME_GAM
         SET GAM_STATUS = 'OPEN',
             GAM_CURRENT_QUESTION_INDEX = ?
         WHERE GAM_ID = ?`
      ).run(newQuestionIndex, game!.GAM_ID);
    });

    update();

    // CA-21: Log succès
    logInfo("GAME_RECOVERED", {
      game_id: game.GAM_ID,
      old_status: oldStatus,
      new_question_index: newQuestionIndex,
    });
  } catch (error: unknown) {
    // CA-9, CA-23: Échec -> log ERROR et continuer le démarrage
    logError("GAME_RECOVERY_FAILED", {
      game_id: game.GAM_ID,
      error: (error as Error).message,
    });
  }
}
