/**
 * Repository d'accès à la table T_USER_USR.
 * Reçoit l'instance DB par injection (pas d'import global).
 */

import Database from "better-sqlite3";
import { UserRow } from "../types/index.ts";

type UserBasic = Pick<UserRow, "USR_ID" | "USR_USERNAME" | "USR_ROLE">;
type UserWithPassword = Pick<UserRow, "USR_ID" | "USR_USERNAME" | "USR_PASSWORD" | "USR_ROLE">;

export function findById(db: Database.Database, id: string): UserBasic | undefined {
  return db
    .prepare(
      "SELECT USR_ID, USR_USERNAME, USR_ROLE FROM T_USER_USR WHERE USR_ID = ?"
    )
    .get(id) as UserBasic | undefined;
}

export function findByUsername(db: Database.Database, username: string): UserWithPassword | undefined {
  return db
    .prepare(
      "SELECT USR_ID, USR_USERNAME, USR_PASSWORD, USR_ROLE FROM T_USER_USR WHERE USR_USERNAME = ?"
    )
    .get(username) as UserWithPassword | undefined;
}

export function countUsers(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM T_USER_USR").get() as { count: number }).count;
}

interface InsertUserParams {
  id: string;
  username: string;
  password: string;
  role: string;
  createdAt: string;
}

export function insertUser(db: Database.Database, { id, username, password, role, createdAt }: InsertUserParams): void {
  db.prepare(
    `INSERT INTO T_USER_USR (USR_ID, USR_USERNAME, USR_PASSWORD, USR_ROLE, USR_CREATED_AT)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, username, password, role, createdAt);
}
