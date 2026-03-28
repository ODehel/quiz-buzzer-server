import { jest } from "@jest/globals";
import { openDatabase } from "../../src/database/database.js";
import { recoverInterruptedGame } from "../../src/game/gameRecovery.js";
import logger from "../../src/config/logger.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  return openDatabase(":memory:");
}

function insertGame(db, { id = "gam-1", quizId = "quiz-1", status = "OPEN", questionIndex = 0 } = {}) {
  // Ensure quiz exists
  db.prepare(
    `INSERT OR IGNORE INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT) VALUES (?, ?, ?)`
  ).run(quizId, "Quiz Test", "2026-03-27T10:00:00.000Z");

  db.prepare(
    `INSERT INTO T_GAME_GAM (GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CURRENT_QUESTION_INDEX, GAM_CREATED_AT)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, quizId, status, questionIndex, "2026-03-27T10:00:00.000Z");
}

function getGame(db, id = "gam-1") {
  return db.prepare("SELECT * FROM T_GAME_GAM WHERE GAM_ID = ?").get(id);
}

// ─── Spy on logger ───────────────────────────────────────────────────────────

let logInfoSpy;
let logErrorSpy;

beforeEach(() => {
  logInfoSpy = jest.spyOn(logger, "info").mockImplementation(() => {});
  logErrorSpy = jest.spyOn(logger, "error").mockImplementation(() => {});
});

afterEach(() => {
  logInfoSpy.mockRestore();
  logErrorSpy.mockRestore();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("recoverInterruptedGame", () => {
  // CA-1, CA-22: Aucune partie en statut intermédiaire
  test("CA-1/CA-22: no intermediate game — logs GAME_RECOVERY_NONE, no DB changes", () => {
    const db = createTestDb();
    insertGame(db, { status: "OPEN" });

    recoverInterruptedGame(db);

    const game = getGame(db);
    expect(game.GAM_STATUS).toBe("OPEN");
    expect(logInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "GAME_RECOVERY_NONE" })
    );
  });

  // CA-2, CA-21: Partie en statut intermédiaire QUESTION_OPEN → recovery
  test("CA-2/CA-21: game in QUESTION_OPEN — recovers to OPEN, logs GAME_RECOVERED", () => {
    const db = createTestDb();
    insertGame(db, { status: "QUESTION_OPEN", questionIndex: 3 });

    recoverInterruptedGame(db);

    const game = getGame(db);
    expect(game.GAM_STATUS).toBe("OPEN");
    expect(game.GAM_CURRENT_QUESTION_INDEX).toBe(3);
    expect(logInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "GAME_RECOVERED" })
    );
    // CA-21: Vérifier les données du log
    const logCall = logInfoSpy.mock.calls.find((c) => c[0]?.event === "GAME_RECOVERED");
    expect(logCall).toBeDefined();
    expect(logCall[0]).toEqual(expect.objectContaining({
      game_id: "gam-1",
      old_status: "QUESTION_OPEN",
      new_question_index: 3,
    }));
  });

  // CA-2: Partie en QUESTION_TITLE
  test("CA-2: game in QUESTION_TITLE — recovers to OPEN, same index", () => {
    const db = createTestDb();
    insertGame(db, { status: "QUESTION_TITLE", questionIndex: 2 });

    recoverInterruptedGame(db);

    const game = getGame(db);
    expect(game.GAM_STATUS).toBe("OPEN");
    expect(game.GAM_CURRENT_QUESTION_INDEX).toBe(2);
  });

  // CA-2: Partie en QUESTION_BUZZED
  test("CA-2: game in QUESTION_BUZZED — recovers to OPEN, same index", () => {
    const db = createTestDb();
    insertGame(db, { status: "QUESTION_BUZZED", questionIndex: 5 });

    recoverInterruptedGame(db);

    const game = getGame(db);
    expect(game.GAM_STATUS).toBe("OPEN");
    expect(game.GAM_CURRENT_QUESTION_INDEX).toBe(5);
  });

  // CA-3: QUESTION_CLOSED → index + 1 (question terminée, passer à la suivante)
  test("CA-3: game in QUESTION_CLOSED — recovers to OPEN, index + 1", () => {
    const db = createTestDb();
    insertGame(db, { status: "QUESTION_CLOSED", questionIndex: 4 });

    recoverInterruptedGame(db);

    const game = getGame(db);
    expect(game.GAM_STATUS).toBe("OPEN");
    expect(game.GAM_CURRENT_QUESTION_INDEX).toBe(5);
  });

  // CA-4: Première question interrompue → index reste à 0
  test("CA-4: first question interrupted — index stays at 0", () => {
    const db = createTestDb();
    insertGame(db, { status: "QUESTION_OPEN", questionIndex: 0 });

    recoverInterruptedGame(db);

    const game = getGame(db);
    expect(game.GAM_STATUS).toBe("OPEN");
    expect(game.GAM_CURRENT_QUESTION_INDEX).toBe(0);
  });

  // CA-5: Partie en IN_ERROR — pas de restauration
  test("CA-5: game in IN_ERROR — not modified", () => {
    const db = createTestDb();
    insertGame(db, { status: "IN_ERROR", questionIndex: 2 });

    recoverInterruptedGame(db);

    const game = getGame(db);
    expect(game.GAM_STATUS).toBe("IN_ERROR");
    expect(game.GAM_CURRENT_QUESTION_INDEX).toBe(2);
    expect(logInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "GAME_RECOVERY_NONE" })
    );
  });

  // CA-6: Partie en PENDING — pas de modification
  test("CA-6: game in PENDING — not modified", () => {
    const db = createTestDb();
    insertGame(db, { status: "PENDING", questionIndex: 0 });

    recoverInterruptedGame(db);

    const game = getGame(db);
    expect(game.GAM_STATUS).toBe("PENDING");
  });

  // CA-7: Partie en COMPLETED — pas de modification
  test("CA-7: game in COMPLETED — not modified", () => {
    const db = createTestDb();
    insertGame(db, { status: "COMPLETED", questionIndex: 10 });

    recoverInterruptedGame(db);

    const game = getGame(db);
    expect(game.GAM_STATUS).toBe("COMPLETED");
  });

  // CA-9: Échec de la transaction — log ERROR, serveur continue
  test("CA-9/CA-23: DB failure — logs GAME_RECOVERY_FAILED, does not throw", () => {
    const db = createTestDb();
    insertGame(db, { status: "QUESTION_OPEN", questionIndex: 2 });

    // Close the DB to simulate a failure
    db.close();

    // Should not throw
    expect(() => recoverInterruptedGame(db)).not.toThrow();

    expect(logErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "GAME_RECOVERY_FAILED" })
    );
  });

  // CA-1: No games at all in DB
  test("CA-1: empty database — logs GAME_RECOVERY_NONE", () => {
    const db = createTestDb();

    recoverInterruptedGame(db);

    expect(logInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "GAME_RECOVERY_NONE" })
    );
  });

  // CA-9: Atomic transaction — either all or nothing
  test("CA-9: update is atomic (transaction)", () => {
    const db = createTestDb();
    insertGame(db, { status: "QUESTION_OPEN", questionIndex: 3 });

    recoverInterruptedGame(db);

    const game = getGame(db);
    // Both status and index updated together
    expect(game.GAM_STATUS).toBe("OPEN");
    expect(game.GAM_CURRENT_QUESTION_INDEX).toBe(3);
  });

  // Multiple games: only intermediate one is recovered
  test("recovers only the game in intermediate status", () => {
    const db = createTestDb();
    insertGame(db, { id: "gam-completed", status: "COMPLETED", questionIndex: 10 });
    insertGame(db, { id: "gam-interrupted", status: "QUESTION_BUZZED", questionIndex: 2 });

    recoverInterruptedGame(db);

    expect(getGame(db, "gam-completed").GAM_STATUS).toBe("COMPLETED");
    expect(getGame(db, "gam-interrupted").GAM_STATUS).toBe("OPEN");
    expect(getGame(db, "gam-interrupted").GAM_CURRENT_QUESTION_INDEX).toBe(2);
  });
});
