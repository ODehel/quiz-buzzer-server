import { openDatabase } from "../src/database/database.js";
import { insertQuizQuestions, insertQuiz, getQuizQuestionIds } from "../src/repositories/quizRepository.js";
import {
  createQuiz,
  listQuizzes,
  updateQuizById,
  deleteQuizById,
  normalizeName,
  validateUuid,
} from "../src/services/quizService.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = openDatabase(":memory:");
  db.prepare(
    `INSERT INTO T_THEME_THM (THM_ID, THM_NAME, THM_CREATED_AT) VALUES (?, ?, ?)`
  ).run("thm-1", "Science", "2026-03-13T10:00:00.000Z");

  for (let i = 1; i <= 15; i++) {
    db.prepare(
      `INSERT INTO T_QUESTION_QST
         (QST_ID, QST_TYPE, QST_THEME_ID, QST_TITLE,
          QST_CORRECT_ANSWER, QST_LEVEL, QST_TIME_LIMIT, QST_POINTS, QST_CREATED_AT)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `qst-${i}`, i % 2 === 0 ? "MCQ" : "SPEED", "thm-1",
      `Question numéro ${i} valide pour un quiz de test ?`,
      "Réponse", (i % 5) + 1, 30, 5, "2026-03-13T10:00:00.000Z"
    );
  }
  return db;
}

const Q10 = Array.from({ length: 10 }, (_, i) => `qst-${i + 1}`);
const Q12 = Array.from({ length: 12 }, (_, i) => `qst-${i + 1}`);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("normalizeName", () => {
  it("trims and collapses spaces", () => {
    expect(normalizeName("  Mon   quiz  ")).toBe("Mon quiz");
  });
});

describe("validateUuid", () => {
  it("accepts a valid UUID", () => {
    expect(() => validateUuid("018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a")).not.toThrow();
  });
  it("rejects an invalid UUID", () => {
    expect(() => validateUuid("not-a-uuid")).toThrow(
      expect.objectContaining({ status: 400, error: "INVALID_UUID" })
    );
  });
});

describe("createQuiz", () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => db.close());

  // CA-1 : Création valide
  it("CA-1: creates a quiz with valid name and 10 questions", () => {
    const quiz = createQuiz(db, "Culture générale", Q10);
    expect(quiz.name).toBe("Culture générale");
    expect(quiz.question_count).toBe(10);
    expect(quiz.last_updated_at).toBeNull();
    expect(quiz.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(quiz.created_at).toBeDefined();
  });

  // CA-2 : Normalisation du nom
  it("CA-2: normalizes name before validation", () => {
    const quiz = createQuiz(db, "  Culture   générale  ", Q10);
    expect(quiz.name).toBe("Culture générale");
  });

  // CA-3 : Regex du nom
  it("CA-3: rejects name not starting with uppercase", () => {
    expect(() => createQuiz(db, "culture générale", Q10)).toThrow(
      expect.objectContaining({ status: 400, error: "VALIDATION_ERROR" })
    );
  });
  it("CA-3: rejects name too short (< 3 chars)", () => {
    expect(() => createQuiz(db, "Ab", Q10)).toThrow(
      expect.objectContaining({ status: 400, error: "VALIDATION_ERROR" })
    );
  });
  it("CA-3: rejects name ending with special char", () => {
    expect(() => createQuiz(db, "Culture générale!", Q10)).toThrow(
      expect.objectContaining({ status: 400, error: "VALIDATION_ERROR" })
    );
  });

  // CA-4 : Unicité insensible à la casse
  it("CA-4: rejects duplicate name (case-insensitive)", () => {
    createQuiz(db, "Culture générale", Q10);
    expect(() => createQuiz(db, "CULTURE GÉNÉRALE", Q10)).toThrow(
      expect.objectContaining({ status: 409, error: "CONFLICT" })
    );
  });

  // CA-5 : Minimum 10 questions
  it("CA-5: rejects less than 10 questions", () => {
    expect(() => createQuiz(db, "Mon quiz", ["qst-1", "qst-2"])).toThrow(
      expect.objectContaining({ status: 400, error: "VALIDATION_ERROR" })
    );
  });

  // CA-6 : Doublons
  it("CA-6: rejects duplicate question IDs", () => {
    const withDuplicate = ["qst-1", "qst-1", ...Q10.slice(2)];
    expect(() => createQuiz(db, "Mon quiz", withDuplicate)).toThrow(
      expect.objectContaining({ status: 400, error: "VALIDATION_ERROR" })
    );
  });

  // CA-7 : UUID valide
  it("CA-7: rejects invalid question UUID", () => {
    const withBadUuid = ["not-a-uuid", ...Q10.slice(1)];
    expect(() => createQuiz(db, "Mon quiz", withBadUuid)).toThrow(
      expect.objectContaining({ status: 400, error: "INVALID_UUID" })
    );
  });

  // CA-8 : Question existante
  it("CA-8: rejects question ID that does not exist in DB", () => {
    const withGhost = ["018e4f5a-0000-0000-0000-000000000000", ...Q10.slice(1)];
    expect(() => createQuiz(db, "Mon quiz", withGhost)).toThrow(
      expect.objectContaining({ status: 404, error: "QUESTION_NOT_FOUND" })
    );
  });

  // CA-10 : ID UUIDv7 et CA-11 : timestamps
  it("CA-10/11: generates UUIDv7 id and ISO timestamps", () => {
    const quiz = createQuiz(db, "Mon quiz", Q10);
    expect(quiz.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(new Date(quiz.created_at).toISOString()).toBe(quiz.created_at);
  });
});

describe("listQuizzes", () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => db.close());

  // CA-15 / CA-16 : Liste vide
  it("CA-16: returns empty array when no quizzes", () => {
    expect(listQuizzes(db, null)).toEqual([]);
  });

  // CA-17 : Tri décroissant
  it("CA-17: returns quizzes sorted by creation date (newest first)", () => {
    createQuiz(db, "Premier quiz", Q10);
    createQuiz(db, "Deuxième quiz", Q12);
    const result = listQuizzes(db, null);
    expect(result[0].name).toBe("Deuxième quiz");
    expect(result[1].name).toBe("Premier quiz");
  });

  // CA-18 : Filtrage
  it("CA-18: filters by name (contains, case-insensitive)", () => {
    createQuiz(db, "Culture générale", Q10);
    createQuiz(db, "Sport et loisirs", Q12);
    expect(listQuizzes(db, "culture")).toHaveLength(1);
    expect(listQuizzes(db, "CULTURE")).toHaveLength(1);
    expect(listQuizzes(db, "sport")).toHaveLength(1);
    expect(listQuizzes(db, "xyz")).toHaveLength(0);
  });

  // CA-19 : question_summary
  it("CA-19: each quiz has question_summary with total and by_level", () => {
    createQuiz(db, "Mon quiz", Q10);
    const result = listQuizzes(db, null);
    expect(result[0].question_summary.total).toBe(10);
    expect(result[0].question_summary.by_level).toBeDefined();
    for (let lvl = 1; lvl <= 5; lvl++) {
      expect(result[0].question_summary.by_level[String(lvl)]).toBeDefined();
    }
  });
});

describe("updateQuizById", () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => db.close());

  // CA-20 : Modification valide
  it("CA-20: updates name and question list, sets last_updated_at", () => {
    const created = createQuiz(db, "Mon quiz", Q10);
    const updated = updateQuizById(db, created.id, "Mon quiz modifié", Q12);
    expect(updated.name).toBe("Mon quiz modifié");
    expect(updated.question_count).toBe(12);
    expect(updated.last_updated_at).not.toBeNull();
  });

  // CA-21 : Modifier le nom seul sans changer les questions
  it("CA-21: allows updating name only, questions unchanged", () => {
    const created = createQuiz(db, "Mon quiz", Q10);
    const updated = updateQuizById(db, created.id, "Mon quiz renommé", Q10);

    expect(updated.name).toBe("Mon quiz renommé");
    expect(updated.question_count).toBe(10);
    expect(updated.last_updated_at).not.toBeNull();
  });

  // CA-23 : La liste remplace entièrement l'ancienne, ordre garanti
  it("CA-23: replaces question list entirely with new order", () => {
    const created = createQuiz(db, "Mon quiz", Q10);
    const reversedIds = [...Q10].reverse();

    updateQuizById(db, created.id, "Mon quiz", reversedIds);

    // Vérifier l'ordre réel en base via le repository
    const storedIds = getQuizQuestionIds(db, created.id);
    expect(storedIds).toEqual(reversedIds);
  });

  // CA-24 : Pas de mise à jour inutile
  it("CA-24: does not modify last_updated_at when data is identical", () => {
    const created = createQuiz(db, "Mon quiz", Q10);
    const updated = updateQuizById(db, created.id, "Mon quiz", Q10);
    expect(updated.last_updated_at).toBeNull();
    expect(updated.name).toBe("Mon quiz");
  });

  // CA-25 : ID dans le body ne correspond pas
  it("CA-25: throws ID_MISMATCH when body id does not match URL id", () => {
    const created = createQuiz(db, "Mon quiz", Q10);
    expect(() =>
      updateQuizById(db, created.id, "Mon quiz modifié", Q10, "018e4f5a-0000-0000-0000-000000000000")
    ).toThrow(
      expect.objectContaining({ status: 400, error: "ID_MISMATCH" })
    );
  });

  // CA-26 : ID inexistant
  it("CA-26: throws NOT_FOUND for unknown quiz ID", () => {
    expect(() =>
      updateQuizById(db, "018e4f5a-8c3b-7d2e-9f1a-000000000099", "Mon quiz", Q10)
    ).toThrow(
      expect.objectContaining({ status: 404, error: "NOT_FOUND" })
    );
  });

  // CA-27 : ID mal formé
  it("CA-27: throws INVALID_UUID for malformed quiz ID", () => {
    expect(() =>
      updateQuizById(db, "not-a-uuid", "Mon quiz", Q10)
    ).toThrow(
      expect.objectContaining({ status: 400, error: "INVALID_UUID" })
    );
  });

  // CA-22 : Les mêmes validations que POST s'appliquent
  it("CA-22: applies same validations as POST (e.g. min 10 questions)", () => {
    const created = createQuiz(db, "Mon quiz", Q10);
    expect(() =>
      updateQuizById(db, created.id, "Mon quiz", ["qst-1", "qst-2"])
    ).toThrow(
      expect.objectContaining({ status: 400, error: "VALIDATION_ERROR" })
    );
  });
});

describe("deleteQuizById", () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => db.close());

  // CA-29 : Suppression réussie
  it("CA-29: deletes quiz and returns nothing", () => {
    const quiz = createQuiz(db, "Mon quiz", Q10);
    expect(() => deleteQuizById(db, quiz.id)).not.toThrow();
  });

  // CA-30 : Cascade sur T_QUIZ_QUESTION_QQN
  it("CA-30: deletes question links in cascade", () => {
    const quiz = createQuiz(db, "Mon quiz", Q10);
    deleteQuizById(db, quiz.id);
    const rows = db.prepare(
      "SELECT * FROM T_QUIZ_QUESTION_QQN WHERE QQN_QUIZ_ID = ?"
    ).all(quiz.id);
    expect(rows).toHaveLength(0);
  });

  // CA-33 : ID inexistant
  it("CA-33: throws NOT_FOUND for unknown quiz ID", () => {
    expect(() =>
      deleteQuizById(db, "018e4f5a-8c3b-7d2e-9f1a-000000000099")
    ).toThrow(
      expect.objectContaining({ status: 404, error: "NOT_FOUND" })
    );
  });

  // CA-34 : ID mal formé
  it("CA-34: throws INVALID_UUID for malformed ID", () => {
    expect(() => deleteQuizById(db, "not-a-uuid")).toThrow(
      expect.objectContaining({ status: 400, error: "INVALID_UUID" })
    );
  });
});