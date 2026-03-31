/**
 * Repository d'accès à la table T_SOUND_SND.
 * Reçoit l'instance DB par injection (pas d'import global).
 */

import Database from "better-sqlite3";
import { SoundRow } from "../types/index.ts";

interface InsertSoundParams {
  id: string;
  name: string;
  filename: string;
  createdAt: string;
}

export function insertSound(db: Database.Database, { id, name, filename, createdAt }: InsertSoundParams): void {
  db.prepare(
    `INSERT INTO T_SOUND_SND (SND_ID, SND_NAME, SND_FILENAME, SND_CREATED_AT)
     VALUES (?, ?, ?, ?)`
  ).run(id, name, filename, createdAt);
}

export function findSoundById(db: Database.Database, id: string): SoundRow | undefined {
  return db
    .prepare("SELECT SND_ID, SND_NAME, SND_FILENAME, SND_CREATED_AT FROM T_SOUND_SND WHERE SND_ID = ?")
    .get(id) as SoundRow | undefined;
}

/**
 * Recherche un son par nom (insensible à la casse grâce à COLLATE NOCASE).
 */
export function findSoundByName(db: Database.Database, name: string): Pick<SoundRow, "SND_ID" | "SND_NAME"> | undefined {
  return db
    .prepare("SELECT SND_ID, SND_NAME FROM T_SOUND_SND WHERE SND_NAME = ?")
    .get(name) as Pick<SoundRow, "SND_ID" | "SND_NAME"> | undefined;
}

/**
 * Liste les sons avec pagination, triés par ID descendant.
 */
export function findAllSounds(db: Database.Database, page: number, limit: number): { data: SoundRow[]; total: number } {
  const total = (db.prepare("SELECT COUNT(*) AS count FROM T_SOUND_SND").get() as { count: number }).count;
  const offset = (page - 1) * limit;
  const data = db
    .prepare(
      `SELECT SND_ID, SND_NAME, SND_FILENAME, SND_CREATED_AT
       FROM T_SOUND_SND
       ORDER BY SND_ID DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as SoundRow[];
  return { data, total };
}

/**
 * Supprime un son par son ID.
 */
export function deleteSound(db: Database.Database, id: string): number {
  return db.prepare("DELETE FROM T_SOUND_SND WHERE SND_ID = ?").run(id).changes;
}
