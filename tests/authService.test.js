import bcrypt from "bcrypt";
import Database from "better-sqlite3";
import { jest } from "@jest/globals";
import { authenticate } from "../src/services/authService.js";
import logger from "../src/config/logger.js";

const TEST_CONFIG = {
  jwtSecret: "a-test-secret-that-is-at-least-32-characters-long!!",
  jwtExpiration: 3600,
};

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

describe("authService.authenticate", () => {
  let db;
  let logInfoSpy, logWarnSpy;

  beforeAll(async () => {
    db = createTestDb();
    const hash = await bcrypt.hash("ValidPassword1!", 10);
    db.prepare(
      "INSERT INTO T_USER_USR (USR_ID, USR_USERNAME, USR_PASSWORD, USR_ROLE, USR_CREATED_AT) VALUES (?,?,?,?,?)"
    ).run("018e4f5a-0000-7000-8000-000000000001", "testadmin", hash, "admin", new Date().toISOString());
  });

  beforeEach(() => {
    logInfoSpy = jest.spyOn(logger, "info").mockImplementation(() => {});
    logWarnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    logInfoSpy.mockRestore();
    logWarnSpy.mockRestore();
  });

  afterAll(() => db.close());

  it("should return a token for valid credentials", async () => {
    const result = await authenticate(db, TEST_CONFIG, "testadmin", "ValidPassword1!", "127.0.0.1");

    expect(result).toHaveProperty("token");
    expect(result.token_type).toBe("Bearer");
    expect(result.expires_in).toBe(3600);
  });

  it("should throw INVALID_CREDENTIALS for wrong password", async () => {
    await expect(
      authenticate(db, TEST_CONFIG, "testadmin", "WrongPassword!!", "127.0.0.1")
    ).rejects.toMatchObject({ error: "INVALID_CREDENTIALS", status: 401 });
  });

  it("should throw INVALID_CREDENTIALS for unknown user (timing-safe)", async () => {
    await expect(
      authenticate(db, TEST_CONFIG, "nobody", "ValidPassword1!", "127.0.0.1")
    ).rejects.toMatchObject({ error: "INVALID_CREDENTIALS", status: 401 });
  });

  it("should be case-insensitive for username (COLLATE NOCASE)", async () => {
    const result = await authenticate(db, TEST_CONFIG, "TESTADMIN", "ValidPassword1!", "127.0.0.1");
    expect(result).toHaveProperty("token");
  });

  // CA-14 : Les connexions réussies sont loggées
  it("CA-14: should log LOGIN_SUCCESS on successful authentication", async () => {
    await authenticate(db, TEST_CONFIG, "testadmin", "ValidPassword1!", "10.0.0.1");

    expect(logInfoSpy).toHaveBeenCalledTimes(1);
    expect(logInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "LOGIN_SUCCESS",
        username: "testadmin",
        ip: "10.0.0.1",
      })
    );
  });

  // CA-15 : Les connexions échouées sont loggées
  it("CA-15: should log LOGIN_FAILURE on failed authentication", async () => {
    await authenticate(db, TEST_CONFIG, "testadmin", "WrongPassword!!", "10.0.0.2").catch(() => {});

    expect(logWarnSpy).toHaveBeenCalledTimes(1);
    expect(logWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "LOGIN_FAILURE",
        username: "testadmin",
        ip: "10.0.0.2",
      })
    );
  });
});