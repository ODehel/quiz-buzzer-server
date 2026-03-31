/**
 * Repository d'accès aux tables T_GAME_GAM et T_GAME_PARTICIPANT_GPA.
 * Reçoit l'instance DB par injection (DIP — pas d'import global).
 */

import Database from "better-sqlite3";
import { GameRow, GameStatus, ParticipantRow } from "../types/index.ts";

interface InsertGameParams {
  id: string;
  quizId: string;
  createdAt: string;
}

/**
 * Insère une nouvelle partie (statut PENDING par défaut).
 */
export function insertGame(db: Database.Database, { id, quizId, createdAt }: InsertGameParams): void {
  db.prepare(
    `INSERT INTO T_GAME_GAM (GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT)
     VALUES (?, ?, 'PENDING', ?)`
  ).run(id, quizId, createdAt);
}

/**
 * Insère les participants d'une partie (ordre 1-based).
 */
export function insertParticipants(db: Database.Database, gameId: string, names: string[]): void {
  const stmt = db.prepare(
    `INSERT INTO T_GAME_PARTICIPANT_GPA (GPA_GAME_ID, GPA_NAME, GPA_ORDER)
     VALUES (?, ?, ?)`
  );
  names.forEach((name, index) => {
    stmt.run(gameId, name, index + 1);
  });
}

/**
 * Retourne une partie par son ID.
 */
export function findGameById(db: Database.Database, id: string): GameRow | undefined {
  return db
    .prepare(
      `SELECT GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT, GAM_LAST_UPDATED_AT
       FROM T_GAME_GAM WHERE GAM_ID = ?`
    )
    .get(id) as GameRow | undefined;
}

/**
 * Retourne les participants d'une partie, triés par ordre croissant.
 */
export function findParticipantsByGameId(db: Database.Database, gameId: string): Pick<ParticipantRow, "GPA_ORDER" | "GPA_NAME">[] {
  return db
    .prepare(
      `SELECT GPA_ORDER, GPA_NAME FROM T_GAME_PARTICIPANT_GPA
       WHERE GPA_GAME_ID = ? ORDER BY GPA_ORDER`
    )
    .all(gameId) as Pick<ParticipantRow, "GPA_ORDER" | "GPA_NAME">[];
}

/**
 * Retourne toutes les parties, triées par date de création décroissante.
 */
export function findAllGames(db: Database.Database): GameRow[] {
  return db
    .prepare(
      `SELECT GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT, GAM_LAST_UPDATED_AT
       FROM T_GAME_GAM ORDER BY GAM_CREATED_AT DESC`
    )
    .all() as GameRow[];
}

/**
 * Retourne les parties avec pagination, triées par date de création décroissante.
 */
export function findAllGamesPaginated(db: Database.Database, page: number, limit: number): { data: GameRow[]; total: number } {
  const total = (db.prepare("SELECT COUNT(*) AS count FROM T_GAME_GAM").get() as { count: number }).count;
  const offset = (page - 1) * limit;
  const data = db
    .prepare(
      `SELECT GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT, GAM_LAST_UPDATED_AT
       FROM T_GAME_GAM
       ORDER BY GAM_CREATED_AT DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as GameRow[];
  return { data, total };
}

/**
 * Retourne le nombre de parties actives (tous les états sauf COMPLETED ou IN_ERROR, cf. US-011).
 */
export function countActiveGames(db: Database.Database): number {
  return (db
    .prepare(
      `SELECT COUNT(*) AS count FROM T_GAME_GAM
       WHERE GAM_STATUS NOT IN ('COMPLETED', 'IN_ERROR')`
    )
    .get() as { count: number }).count;
}

/**
 * Met à jour le statut d'une partie.
 */
export function updateGameStatus(db: Database.Database, id: string, status: GameStatus): void {
  db.prepare(`UPDATE T_GAME_GAM SET GAM_STATUS = ? WHERE GAM_ID = ?`).run(status, id);
}

/**
 * Met à jour l'horodatage de modification d'une partie.
 */
export function updateGameLastUpdated(db: Database.Database, id: string, lastUpdatedAt: string): void {
  db.prepare(`UPDATE T_GAME_GAM SET GAM_LAST_UPDATED_AT = ? WHERE GAM_ID = ?`).run(lastUpdatedAt, id);
}

/**
 * Supprime tous les participants d'une partie.
 */
export function deleteParticipantsByGameId(db: Database.Database, gameId: string): void {
  db.prepare(`DELETE FROM T_GAME_PARTICIPANT_GPA WHERE GPA_GAME_ID = ?`).run(gameId);
}

/**
 * Retourne un participant par son ordre dans une partie.
 */
export function findParticipantByOrder(db: Database.Database, gameId: string, order: number): Pick<ParticipantRow, "GPA_ORDER" | "GPA_NAME"> | undefined {
  return db
    .prepare(
      `SELECT GPA_ORDER, GPA_NAME FROM T_GAME_PARTICIPANT_GPA
       WHERE GPA_GAME_ID = ? AND GPA_ORDER = ?`
    )
    .get(gameId, order) as Pick<ParticipantRow, "GPA_ORDER" | "GPA_NAME"> | undefined;
}

/**
 * Met à jour le nom d'un participant.
 */
export function updateParticipantName(db: Database.Database, gameId: string, order: number, name: string): void {
  db.prepare(
    `UPDATE T_GAME_PARTICIPANT_GPA SET GPA_NAME = ?
     WHERE GPA_GAME_ID = ? AND GPA_ORDER = ?`
  ).run(name, gameId, order);
}

/**
 * Supprime une partie (les participants sont supprimés en cascade).
 */
export function deleteGameById(db: Database.Database, id: string): number {
  return db.prepare(`DELETE FROM T_GAME_GAM WHERE GAM_ID = ?`).run(id).changes;
}
