import Database from "better-sqlite3";
import {
  findById,
  findByUsername,
  countUsers,
  insertUser,
} from "../src/repositories/userRepository.js";

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

describe("userRepository", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => db.close());

  describe("countUsers", () => {
    it("should return 0 on an empty table", () => {
      expect(countUsers(db)).toBe(0);
    });

    it("should return the correct count after inserts", () => {
      insertUser(db, {
        id: "id-1",
        username: "user1",
        password: "hashed",
        role: "admin",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      insertUser(db, {
        id: "id-2",
        username: "user2",
        password: "hashed",
        role: "buzzer",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      expect(countUsers(db)).toBe(2);
    });
  });

  describe("insertUser", () => {
    it("should insert a user that can be retrieved", () => {
      insertUser(db, {
        id: "id-1",
        username: "admin",
        password: "hashed_password",
        role: "admin",
        createdAt: "2026-03-07T10:00:00.000Z",
      });

      const user = findByUsername(db, "admin");
      expect(user).toBeDefined();
      expect(user.USR_ID).toBe("id-1");
      expect(user.USR_PASSWORD).toBe("hashed_password");
      expect(user.USR_ROLE).toBe("admin");
    });
  });

  describe("findByUsername", () => {
    it("should return undefined for a non-existent user", () => {
      expect(findByUsername(db, "nobody")).toBeUndefined();
    });

    it("should find a user case-insensitively", () => {
      insertUser(db, {
        id: "id-1",
        username: "TestUser",
        password: "hashed",
        role: "buzzer",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      expect(findByUsername(db, "testuser")).toBeDefined();
      expect(findByUsername(db, "TESTUSER")).toBeDefined();
    });
  });

  describe("findById", () => {
    it("should return undefined for a non-existent ID", () => {
      expect(findById(db, "unknown-id")).toBeUndefined();
    });

    it("should return the user for a known ID", () => {
      insertUser(db, {
        id: "uuid-42",
        username: "buzzer01",
        password: "hashed",
        role: "buzzer",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const user = findById(db, "uuid-42");
      expect(user).toBeDefined();
      expect(user.USR_ID).toBe("uuid-42");
      expect(user.USR_USERNAME).toBe("buzzer01");
      expect(user.USR_ROLE).toBe("buzzer");
    });
  });
});