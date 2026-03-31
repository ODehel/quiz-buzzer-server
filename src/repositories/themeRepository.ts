/**
 * Repository d'accès à la table T_THEME_THM.
 * Reçoit l'instance DB par injection (pas d'import global).
 */

import Database from "better-sqlite3";
import { ThemeRow } from "../types/index.ts";

interface InsertThemeParams {
  id: string;
  name: string;
  createdAt: string;
}

export function insertTheme(db: Database.Database, { id, name, createdAt }: InsertThemeParams): void {
  db.prepare(
    `INSERT INTO T_THEME_THM (THM_ID, THM_NAME, THM_CREATED_AT)
     VALUES (?, ?, ?)`
  ).run(id, name, createdAt);
}

export function findById(db: Database.Database, id: string): ThemeRow | undefined {
  return db
    .prepare("SELECT THM_ID, THM_NAME, THM_CREATED_AT, THM_LAST_UPDATED_AT FROM T_THEME_THM WHERE THM_ID = ?")
    .get(id) as ThemeRow | undefined;
}

/**
 * Recherche un thème par nom (insensible à la casse grâce à COLLATE NOCASE).
 */
export function findByName(db: Database.Database, name: string): Pick<ThemeRow, "THM_ID" | "THM_NAME"> | undefined {
  return db
    .prepare("SELECT THM_ID, THM_NAME FROM T_THEME_THM WHERE THM_NAME = ?")
    .get(name) as Pick<ThemeRow, "THM_ID" | "THM_NAME"> | undefined;
}

/**
 * Liste les thèmes avec pagination, triés par ID descendant.
 */
export function findAll(db: Database.Database, page: number, limit: number): { data: ThemeRow[]; total: number } {
  const total = (db.prepare("SELECT COUNT(*) AS count FROM T_THEME_THM").get() as { count: number }).count;
  const offset = (page - 1) * limit;
  const data = db
    .prepare(
      `SELECT THM_ID, THM_NAME, THM_CREATED_AT, THM_LAST_UPDATED_AT
       FROM T_THEME_THM
       ORDER BY THM_ID DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as ThemeRow[];
  return { data, total };
}

/**
 * Met à jour le nom d'un thème et son horodatage de modification.
 */
export function updateTheme(db: Database.Database, id: string, name: string, lastUpdatedAt: string): void {
  db.prepare(
    `UPDATE T_THEME_THM
     SET THM_NAME = ?, THM_LAST_UPDATED_AT = ?
     WHERE THM_ID = ?`
  ).run(name, lastUpdatedAt, id);
}

/**
 * Supprime un thème par son ID.
 */
export function deleteTheme(db: Database.Database, id: string): number {
  return db.prepare("DELETE FROM T_THEME_THM WHERE THM_ID = ?").run(id).changes;
}
