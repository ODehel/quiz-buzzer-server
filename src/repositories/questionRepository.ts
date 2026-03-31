/**
 * Repository d'accès à la table T_QUESTION_QST.
 * Reçoit l'instance DB par injection (pas d'import global).
 */

import Database from "better-sqlite3";
import type { QuestionRow, QuestionType } from "../types/index.ts";

interface InsertQuestionParams {
  id: string;
  type: QuestionType;
  themeId: string;
  title: string;
  choiceA?: string | null;
  choiceB?: string | null;
  choiceC?: string | null;
  choiceD?: string | null;
  correctAnswer: string;
  level: number;
  timeLimit: number;
  points: number;
  createdAt: string;
}

export function insertQuestion(db: Database.Database, q: InsertQuestionParams): void {
  db.prepare(
    `INSERT INTO T_QUESTION_QST (
       QST_ID, QST_TYPE, QST_THEME_ID, QST_TITLE,
       QST_CHOICE_A, QST_CHOICE_B, QST_CHOICE_C, QST_CHOICE_D,
       QST_CORRECT_ANSWER, QST_LEVEL, QST_TIME_LIMIT, QST_POINTS, QST_CREATED_AT
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    q.id, q.type, q.themeId, q.title,
    q.choiceA ?? null, q.choiceB ?? null, q.choiceC ?? null, q.choiceD ?? null,
    q.correctAnswer, q.level, q.timeLimit, q.points, q.createdAt
  );
}

export function findQuestionById(db: Database.Database, id: string): QuestionRow | undefined {
  return db
    .prepare(
      `SELECT q.*, t.THM_NAME
       FROM T_QUESTION_QST q
       LEFT JOIN T_THEME_THM t ON t.THM_ID = q.QST_THEME_ID
       WHERE q.QST_ID = ?`
    )
    .get(id) as QuestionRow | undefined;
}

/**
 * Recherche une question par titre (insensible à la casse grâce à COLLATE NOCASE).
 */
export function findQuestionByTitle(db: Database.Database, title: string): Pick<QuestionRow, "QST_ID" | "QST_TITLE"> | undefined {
  return db
    .prepare("SELECT QST_ID, QST_TITLE FROM T_QUESTION_QST WHERE QST_TITLE = ?")
    .get(title) as Pick<QuestionRow, "QST_ID" | "QST_TITLE"> | undefined;
}

interface QuestionFilters {
  theme_id?: string;
  type?: string;
  level?: number;
  level_min?: number;
  level_max?: number;
  time_limit_min?: number;
  time_limit_max?: number;
  points_min?: number;
  points_max?: number;
}

/**
 * Liste les questions avec pagination et filtrage.
 */
export function findQuestions(db: Database.Database, filters: QuestionFilters, page: number, limit: number): { data: QuestionRow[]; total: number } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.theme_id !== undefined) {
    conditions.push("QST_THEME_ID = ?");
    params.push(filters.theme_id);
  }
  if (filters.type !== undefined) {
    conditions.push("QST_TYPE = ?");
    params.push(filters.type);
  }
  if (filters.level !== undefined) {
    conditions.push("QST_LEVEL = ?");
    params.push(filters.level);
  }
  if (filters.level_min !== undefined) {
    conditions.push("QST_LEVEL >= ?");
    params.push(filters.level_min);
  }
  if (filters.level_max !== undefined) {
    conditions.push("QST_LEVEL <= ?");
    params.push(filters.level_max);
  }
  if (filters.time_limit_min !== undefined) {
    conditions.push("QST_TIME_LIMIT >= ?");
    params.push(filters.time_limit_min);
  }
  if (filters.time_limit_max !== undefined) {
    conditions.push("QST_TIME_LIMIT <= ?");
    params.push(filters.time_limit_max);
  }
  if (filters.points_min !== undefined) {
    conditions.push("QST_POINTS >= ?");
    params.push(filters.points_min);
  }
  if (filters.points_max !== undefined) {
    conditions.push("QST_POINTS <= ?");
    params.push(filters.points_max);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const total = (db
    .prepare(`SELECT COUNT(*) AS count FROM T_QUESTION_QST ${where}`)
    .get(...params) as { count: number }).count;

  const offset = (page - 1) * limit;
  const data = db
    .prepare(
      `SELECT q.*, t.THM_NAME
       FROM T_QUESTION_QST q
       LEFT JOIN T_THEME_THM t ON t.THM_ID = q.QST_THEME_ID
       ${where} ORDER BY q.QST_ID DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as QuestionRow[];

  return { data, total };
}

interface UpdateQuestionFields {
  themeId?: string;
  title?: string;
  choiceA?: string | null;
  choiceB?: string | null;
  choiceC?: string | null;
  choiceD?: string | null;
  correctAnswer?: string;
  level?: number;
  timeLimit?: number;
  points?: number;
  imagePath?: string | null;
  audioPath?: string | null;
}

/**
 * Met à jour les champs d'une question.
 */
export function updateQuestion(db: Database.Database, id: string, fields: UpdateQuestionFields, lastUpdatedAt: string): void {
  const columnMap: Record<string, string> = {
    themeId: "QST_THEME_ID",
    title: "QST_TITLE",
    choiceA: "QST_CHOICE_A",
    choiceB: "QST_CHOICE_B",
    choiceC: "QST_CHOICE_C",
    choiceD: "QST_CHOICE_D",
    correctAnswer: "QST_CORRECT_ANSWER",
    level: "QST_LEVEL",
    timeLimit: "QST_TIME_LIMIT",
    points: "QST_POINTS",
    imagePath: "QST_IMAGE_PATH",
    audioPath: "QST_AUDIO_PATH",
  };

  const setClauses: string[] = [];
  const params: (string | number | null)[] = [];

  for (const [key, column] of Object.entries(columnMap)) {
    if (key in fields) {
      setClauses.push(`${column} = ?`);
      params.push((fields as Record<string, string | number | null | undefined>)[key] ?? null);
    }
  }

  setClauses.push("QST_LAST_UPDATED_AT = ?");
  params.push(lastUpdatedAt);
  params.push(id);

  db.prepare(
    `UPDATE T_QUESTION_QST SET ${setClauses.join(", ")} WHERE QST_ID = ?`
  ).run(...params);
}

/**
 * Supprime une question par son ID.
 */
export function deleteQuestion(db: Database.Database, id: string): number {
  return db.prepare("DELETE FROM T_QUESTION_QST WHERE QST_ID = ?").run(id).changes;
}

/**
 * Insère plusieurs questions en une seule transaction atomique.
 */
export function insertQuestions(db: Database.Database, questions: InsertQuestionParams[]): void {
  const stmt = db.prepare(
    `INSERT INTO T_QUESTION_QST (
       QST_ID, QST_TYPE, QST_THEME_ID, QST_TITLE,
       QST_CHOICE_A, QST_CHOICE_B, QST_CHOICE_C, QST_CHOICE_D,
       QST_CORRECT_ANSWER, QST_LEVEL, QST_TIME_LIMIT, QST_POINTS, QST_CREATED_AT
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertAll = db.transaction((qs: InsertQuestionParams[]) => {
    for (const q of qs) {
      stmt.run(
        q.id, q.type, q.themeId, q.title,
        q.choiceA ?? null, q.choiceB ?? null, q.choiceC ?? null, q.choiceD ?? null,
        q.correctAnswer, q.level, q.timeLimit, q.points, q.createdAt
      );
    }
  });

  insertAll(questions);
}

/**
 * Compte les questions associées à un thème (pour la garde de suppression CA-30 de l'US-003).
 */
export function countQuestionsByTheme(db: Database.Database, themeId: string): number {
  return (db
    .prepare("SELECT COUNT(*) AS count FROM T_QUESTION_QST WHERE QST_THEME_ID = ?")
    .get(themeId) as { count: number }).count;
}
