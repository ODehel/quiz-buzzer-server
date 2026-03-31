/**
 * Repository d'accès aux tables T_QUIZ_QUZ et T_QUIZ_QUESTION_QQN.
 * Reçoit l'instance DB par injection (DIP — pas d'import global).
 */

import Database from "better-sqlite3";
import type { QuizRow, QuizQuestionRow } from "../types/index.ts";

interface InsertQuizParams {
  id: string;
  name: string;
  createdAt: string;
}

export function insertQuiz(db: Database.Database, { id, name, createdAt }: InsertQuizParams): void {
  db.prepare(
    `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT)
     VALUES (?, ?, ?)`
  ).run(id, name, createdAt);
}

/**
 * Insère les liaisons quiz-questions avec leur ordre (CA-9).
 */
export function insertQuizQuestions(db: Database.Database, quizId: string, questionIds: string[]): void {
  const stmt = db.prepare(
    `INSERT INTO T_QUIZ_QUESTION_QQN (QQN_QUIZ_ID, QQN_QUESTION_ID, QQN_ORDER)
     VALUES (?, ?, ?)`
  );
  // Utiliser une transaction pour garantir l'atomicité
  const insertAll = db.transaction((ids: string[]) => {
    ids.forEach((qstId, index) => {
      stmt.run(quizId, qstId, index + 1);
    });
  });
  insertAll(questionIds);
}

export function findQuizById(db: Database.Database, id: string): QuizRow | undefined {
  return db
    .prepare(
      `SELECT QUZ_ID, QUZ_NAME, QUZ_CREATED_AT, QUZ_LAST_UPDATED_AT
       FROM T_QUIZ_QUZ WHERE QUZ_ID = ?`
    )
    .get(id) as QuizRow | undefined;
}

/**
 * Recherche un quiz par nom (insensible à la casse grâce à COLLATE NOCASE).
 */
export function findQuizByName(db: Database.Database, name: string): Pick<QuizRow, "QUZ_ID" | "QUZ_NAME"> | undefined {
  return db
    .prepare(`SELECT QUZ_ID, QUZ_NAME FROM T_QUIZ_QUZ WHERE QUZ_NAME = ?`)
    .get(name) as Pick<QuizRow, "QUZ_ID" | "QUZ_NAME"> | undefined;
}

interface LevelTypeCount {
  level: number;
  type: string;
  count: number;
}

interface ByLevel {
  [level: string]: { MCQ: number; SPEED: number };
}

interface QuizListItem {
  id: string;
  name: string;
  created_at: string;
  last_updated_at: string | null;
  question_summary: { total: number; by_level: ByLevel };
}

/**
 * Liste tous les quiz avec leur question_summary, triés par création décroissante.
 * Filtre optionnel par nom (contient, insensible à la casse) — CA-17, CA-18, CA-19.
 */
export function findAllQuizzes(db: Database.Database, nameFilter: string | null): QuizListItem[] {
  const whereClause = nameFilter
    ? `WHERE LOWER(q.QUZ_NAME) LIKE LOWER(?)`
    : "";
  const params: string[] = nameFilter ? [`%${nameFilter}%`] : [];

  const quizRows = db
    .prepare(
      `SELECT q.QUZ_ID, q.QUZ_NAME, q.QUZ_CREATED_AT, q.QUZ_LAST_UPDATED_AT
       FROM T_QUIZ_QUZ q
       ${whereClause}
       ORDER BY q.QUZ_CREATED_AT DESC, q.QUZ_ID DESC`
    )
    .all(...params) as QuizRow[];

  if (quizRows.length === 0) return [];

  // Calcul du question_summary pour chaque quiz via une jointure (CA-19)
  const summaryStmt = db.prepare(
    `SELECT qst.QST_LEVEL AS level, qst.QST_TYPE AS type, COUNT(*) AS count
     FROM T_QUIZ_QUESTION_QQN qqn
     JOIN T_QUESTION_QST qst ON qst.QST_ID = qqn.QQN_QUESTION_ID
     WHERE qqn.QQN_QUIZ_ID = ?
     GROUP BY qst.QST_LEVEL, qst.QST_TYPE`
  );

  return quizRows.map((row) => {
    const summaryRows = summaryStmt.all(row.QUZ_ID) as LevelTypeCount[];
    const by_level = buildByLevel(summaryRows);
    const total = summaryRows.reduce((sum, r) => sum + r.count, 0);

    return {
      id: row.QUZ_ID,
      name: row.QUZ_NAME,
      created_at: row.QUZ_CREATED_AT,
      last_updated_at: row.QUZ_LAST_UPDATED_AT ?? null,
      question_summary: { total, by_level },
    };
  });
}

/**
 * Construit la structure by_level à partir des rows SQL agrégées.
 * Garantit la présence de tous les niveaux 1-5 (même à 0).
 */
function buildByLevel(rows: LevelTypeCount[]): ByLevel {
  const by_level: ByLevel = {};
  for (let lvl = 1; lvl <= 5; lvl++) {
    by_level[String(lvl)] = { MCQ: 0, SPEED: 0 };
  }
  for (const { level, type, count } of rows) {
    by_level[String(level)][type as "MCQ" | "SPEED"] = count;
  }
  return by_level;
}

/**
 * Retourne les IDs de questions d'un quiz, triés par QQN_ORDER (CA-9).
 */
export function getQuizQuestionIds(db: Database.Database, quizId: string): string[] {
  return (db
    .prepare(
      `SELECT QQN_QUESTION_ID FROM T_QUIZ_QUESTION_QQN
       WHERE QQN_QUIZ_ID = ? ORDER BY QQN_ORDER`
    )
    .all(quizId) as Pick<QuizQuestionRow, "QQN_QUESTION_ID">[])
    .map((r) => r.QQN_QUESTION_ID);
}

/**
 * Met à jour le nom d'un quiz et son horodatage de modification.
 */
export function updateQuiz(db: Database.Database, id: string, name: string, lastUpdatedAt: string): void {
  db.prepare(
    `UPDATE T_QUIZ_QUZ
     SET QUZ_NAME = ?, QUZ_LAST_UPDATED_AT = ?
     WHERE QUZ_ID = ?`
  ).run(name, lastUpdatedAt, id);
}

/**
 * Supprime toutes les liaisons quiz-questions d'un quiz (pour le PUT en transaction).
 */
export function deleteQuizQuestions(db: Database.Database, quizId: string): void {
  db.prepare(
    `DELETE FROM T_QUIZ_QUESTION_QQN WHERE QQN_QUIZ_ID = ?`
  ).run(quizId);
}

/**
 * Supprime un quiz.
 */
export function deleteQuiz(db: Database.Database, id: string): number {
  return db.prepare(`DELETE FROM T_QUIZ_QUZ WHERE QUZ_ID = ?`).run(id).changes;
}

interface QuizWithQuestions {
  id: string;
  name: string;
  question_ids: string[];
  created_at: string;
  last_updated_at: string | null;
}

/**
 * Retourne un quiz avec tous ses détails et ses questions ordonnées (pour GET /api/v1/quizzes/:id).
 */
export function findQuizWithQuestionsById(db: Database.Database, id: string): QuizWithQuestions | undefined {
  const quiz = findQuizById(db, id);
  if (!quiz) {
    return undefined;
  }

  const questionIds = getQuizQuestionIds(db, id);

  return {
    id: quiz.QUZ_ID,
    name: quiz.QUZ_NAME,
    question_ids: questionIds,
    created_at: quiz.QUZ_CREATED_AT,
    last_updated_at: quiz.QUZ_LAST_UPDATED_AT ?? null,
  };
}

/**
 * Compte le nombre de quiz qui utilisent une question donnée (CA-36).
 */
export function countQuizzesByQuestion(db: Database.Database, questionId: string): number {
  return (db
    .prepare(
      `SELECT COUNT(*) AS count FROM T_QUIZ_QUESTION_QQN WHERE QQN_QUESTION_ID = ?`
    )
    .get(questionId) as { count: number }).count;
}
