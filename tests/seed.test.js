import Database from "better-sqlite3";
import { runSeed, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from "../src/seed.js";
import { countUsers } from "../src/repositories/userRepository.js";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE T_USER_USR (
      USR_ID TEXT PRIMARY KEY,
      USR_USERNAME TEXT NOT NULL UNIQUE COLLATE NOCASE,
      USR_PASSWORD TEXT NOT NULL,
      USR_ROLE TEXT NOT NULL DEFAULT 'buzzer' CHECK (USR_ROLE IN ('admin','buzzer')),
      USR_CREATED_AT TEXT NOT NULL,
      USR_LAST_UPDATED_AT TEXT DEFAULT NULL
    );
  `);
  return db;
}

/** Génère un objet env valide avec tous les mots de passe requis. */
function validEnv() {
  return {
    ADMIN_PASSWORD: "AdminPassword1!",
    BUZZER_01_PASSWORD: "BuzzerPass001!",
    BUZZER_02_PASSWORD: "BuzzerPass002!",
    BUZZER_03_PASSWORD: "BuzzerPass003!",
    BUZZER_04_PASSWORD: "BuzzerPass004!",
    BUZZER_05_PASSWORD: "BuzzerPass005!",
    BUZZER_06_PASSWORD: "BuzzerPass006!",
    BUZZER_07_PASSWORD: "BuzzerPass007!",
    BUZZER_08_PASSWORD: "BuzzerPass008!",
    BUZZER_09_PASSWORD: "BuzzerPass009!",
    BUZZER_10_PASSWORD: "BuzzerPass010!",
  };
}

/** Hash factice ultra-rapide pour les tests (pas besoin de bcrypt réel). */
const fakeHash = (pwd) => Promise.resolve(`hashed:${pwd}`);

let idCounter = 0;
const fakeId = () => `fake-id-${++idCounter}`;

describe("runSeed", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    idCounter = 0;
  });

  afterEach(() => db.close());

  // CA-17 : Création des 11 comptes
  it("should insert 11 users when table is empty", async () => {
    const result = await runSeed({
      db,
      env: validEnv(),
      generateId: fakeId,
      hashPassword: fakeHash,
    });

    expect(result.status).toBe("done");
    expect(result.count).toBe(11);
    expect(countUsers(db)).toBe(11);
  });

  // CA-18 : Mots de passe hashés
  it("should store hashed passwords, not plain text", async () => {
    await runSeed({
      db,
      env: validEnv(),
      generateId: fakeId,
      hashPassword: fakeHash,
    });

    const row = db.prepare("SELECT USR_PASSWORD FROM T_USER_USR WHERE USR_USERNAME = ?").get("admin");
    expect(row.USR_PASSWORD).toBe("hashed:AdminPassword1!");
    expect(row.USR_PASSWORD).not.toBe("AdminPassword1!");
  });

  // CA-19 : Idempotent
  it("should skip if table already contains data", async () => {
    await runSeed({
      db,
      env: validEnv(),
      generateId: fakeId,
      hashPassword: fakeHash,
    });

    const result = await runSeed({
      db,
      env: validEnv(),
      generateId: fakeId,
      hashPassword: fakeHash,
    });

    expect(result.status).toBe("skipped");
    expect(countUsers(db)).toBe(11);
  });

  // CA-20 : Mot de passe trop court
  it("should throw if a password is shorter than 12 characters", async () => {
    const env = validEnv();
    env.ADMIN_PASSWORD = "short";

    await expect(
      runSeed({ db, env, generateId: fakeId, hashPassword: fakeHash })
    ).rejects.toThrow(`at least ${MIN_PASSWORD_LENGTH} characters`);
    expect(countUsers(db)).toBe(0);
  });

  // CA-20 : Mot de passe trop long (> 72 chars)
  it("should throw if a password exceeds 72 characters", async () => {
    const env = validEnv();
    env.ADMIN_PASSWORD = "a".repeat(73);

    await expect(
      runSeed({ db, env, generateId: fakeId, hashPassword: fakeHash })
    ).rejects.toThrow(`at most ${MAX_PASSWORD_LENGTH} characters`);
    expect(countUsers(db)).toBe(0);
  });

  // Variable d'environnement manquante
  it("should throw if a password environment variable is missing", async () => {
    const env = validEnv();
    delete env.BUZZER_05_PASSWORD;

    await expect(
      runSeed({ db, env, generateId: fakeId, hashPassword: fakeHash })
    ).rejects.toThrow("BUZZER_05_PASSWORD is not set");
    expect(countUsers(db)).toBe(0);
  });

  // Vérification des rôles insérés
  it("should create 1 admin and 10 buzzers", async () => {
    await runSeed({
      db,
      env: validEnv(),
      generateId: fakeId,
      hashPassword: fakeHash,
    });

    const admins = db.prepare("SELECT COUNT(*) AS c FROM T_USER_USR WHERE USR_ROLE = 'admin'").get();
    const buzzers = db.prepare("SELECT COUNT(*) AS c FROM T_USER_USR WHERE USR_ROLE = 'buzzer'").get();

    expect(admins.c).toBe(1);
    expect(buzzers.c).toBe(10);
  });
});