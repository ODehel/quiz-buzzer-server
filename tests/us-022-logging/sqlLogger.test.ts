import { jest } from "@jest/globals";
import logger from "../../src/config/logger.ts";
import {
  redactSensitiveParams,
  wrapDatabaseWithLogging,
} from "../../src/database/sqlLogger.ts";
import { runWithCorrelationId, getCorrelationId } from "../../src/utils/correlationStore.ts";

// =============================================================================
// CA-27, CA-28: SQL logger tests
// =============================================================================

describe("redactSensitiveParams", () => {
  // CA-28: USR_PASSWORD is masked as "[REDACTED]"
  it("should redact USR_PASSWORD in INSERT queries (CA-28)", () => {
    const query =
      "INSERT INTO users (USR_LOGIN, USR_PASSWORD, USR_ROLE) VALUES (?, ?, ?)";
    const params = ["admin", "secret123", "ADMIN"];

    const result = redactSensitiveParams(query, params);

    expect(result).toEqual(["admin", "[REDACTED]", "ADMIN"]);
  });

  it("should redact USR_PASSWORD in UPDATE queries (CA-28)", () => {
    const query = "UPDATE users SET USR_PASSWORD = ? WHERE USR_LOGIN = ?";
    const params = ["newpassword", "admin"];

    const result = redactSensitiveParams(query, params);

    expect(result).toEqual(["[REDACTED]", "admin"]);
  });

  it("should not redact params when query has no sensitive columns", () => {
    const query =
      "INSERT INTO games (GAME_ID, GAME_NAME) VALUES (?, ?)";
    const params = [1, "My Game"];

    const result = redactSensitiveParams(query, params);

    expect(result).toEqual([1, "My Game"]);
  });

  it("should return params unchanged when params is null or empty", () => {
    expect(redactSensitiveParams("SELECT 1", null)).toBeNull();
    expect(redactSensitiveParams("SELECT 1", [])).toEqual([]);
  });

  it("should be case-insensitive for column detection", () => {
    const query =
      "INSERT INTO users (usr_login, usr_password) VALUES (?, ?)";
    const params = ["admin", "secret"];

    const result = redactSensitiveParams(query, params);

    expect(result).toEqual(["admin", "[REDACTED]"]);
  });

  it("should handle queries with USR_PASSWORD that are not INSERT or UPDATE", () => {
    // e.g., SELECT ... WHERE USR_PASSWORD = ? -- not INSERT or UPDATE pattern
    const query = "SELECT * FROM users WHERE USR_PASSWORD = ?";
    const params = ["secret"];

    // Should return params as-is since neither INSERT nor SET pattern matches
    const result = redactSensitiveParams(query, params);

    expect(result).toEqual(["secret"]);
  });

  it("should handle UPDATE with multiple SET columns including sensitive", () => {
    const query =
      "UPDATE users SET USR_LOGIN = ?, USR_PASSWORD = ? WHERE USR_ID = ?";
    const params = ["newlogin", "newpass", 42];

    const result = redactSensitiveParams(query, params);

    expect(result).toEqual(["newlogin", "[REDACTED]", 42]);
  });
});

describe("wrapDatabaseWithLogging", () => {
  let debugSpy;
  let isLevelSpy;

  afterEach(() => {
    if (debugSpy) debugSpy.mockRestore();
    if (isLevelSpy) isLevelSpy.mockRestore();
  });

  // CA-27: When debug is NOT enabled, wrapDatabaseWithLogging returns db as-is
  it("should return the original db when debug is not enabled (CA-27)", () => {
    const fakeDb = { prepare: jest.fn() };

    // In test mode, isLevelEnabled("debug") is false
    const result = wrapDatabaseWithLogging(fakeDb);

    expect(result).toBe(fakeDb);
  });

  // CA-27: When debug IS enabled, it returns a proxy
  it("should return a proxy when debug is enabled (CA-27)", () => {
    isLevelSpy = jest.spyOn(logger, "isLevelEnabled").mockReturnValue(true);
    debugSpy = jest.spyOn(logger, "debug");

    const fakeDb = {
      prepare: jest.fn(),
      otherProp: "value",
    };

    const proxied = wrapDatabaseWithLogging(fakeDb);

    expect(proxied).not.toBe(fakeDb);
    // Non-prepare properties pass through
    expect(proxied.otherProp).toBe("value");
  });

  it("should wrap prepare to return a proxied statement (CA-27)", () => {
    isLevelSpy = jest.spyOn(logger, "isLevelEnabled").mockReturnValue(true);
    debugSpy = jest.spyOn(logger, "debug");

    const fakeResult = { changes: 1 };
    const fakeStmt = {
      run: jest.fn(() => fakeResult),
      get: jest.fn(() => ({ id: 1 })),
      all: jest.fn(() => [{ id: 1 }, { id: 2 }]),
      bind: jest.fn(),
    };
    const fakeDb = {
      prepare: jest.fn(() => fakeStmt),
    };

    const proxied = wrapDatabaseWithLogging(fakeDb);
    const stmt = proxied.prepare("SELECT * FROM users WHERE id = ?");

    expect(fakeDb.prepare).toHaveBeenCalledWith(
      "SELECT * FROM users WHERE id = ?"
    );

    // Test run
    const runResult = stmt.run(42);
    expect(fakeStmt.run).toHaveBeenCalledWith(42);
    expect(runResult).toBe(fakeResult);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "SQL_QUERY",
        query: "SELECT * FROM users WHERE id = ?",
        duration_ms: expect.any(Number),
      })
    );

    // Test get
    const getResult = stmt.get(1);
    expect(fakeStmt.get).toHaveBeenCalledWith(1);
    expect(getResult).toEqual({ id: 1 });

    // Test all
    const allResult = stmt.all();
    expect(fakeStmt.all).toHaveBeenCalled();
    expect(allResult).toEqual([{ id: 1 }, { id: 2 }]);

    // Non-wrapped methods pass through
    expect(typeof stmt.bind).toBe("function");
  });

  it("should redact sensitive params in SQL log entries (CA-28)", () => {
    isLevelSpy = jest.spyOn(logger, "isLevelEnabled").mockReturnValue(true);
    debugSpy = jest.spyOn(logger, "debug");

    const fakeStmt = {
      run: jest.fn(() => ({ changes: 1 })),
    };
    const fakeDb = {
      prepare: jest.fn(() => fakeStmt),
    };

    const proxied = wrapDatabaseWithLogging(fakeDb);
    const sql =
      "INSERT INTO users (USR_LOGIN, USR_PASSWORD) VALUES (?, ?)";
    const stmt = proxied.prepare(sql);

    stmt.run(["admin", "secret"]);

    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "SQL_QUERY",
        params: ["admin", "[REDACTED]"],
      })
    );
  });

  it("should include correlation_id when available in context (CA-27)", () => {
    isLevelSpy = jest.spyOn(logger, "isLevelEnabled").mockReturnValue(true);
    debugSpy = jest.spyOn(logger, "debug");

    const fakeStmt = {
      run: jest.fn(() => ({ changes: 1 })),
    };
    const fakeDb = {
      prepare: jest.fn(() => fakeStmt),
    };

    const proxied = wrapDatabaseWithLogging(fakeDb);
    const stmt = proxied.prepare("SELECT 1");

    runWithCorrelationId("corr-id-sql-test", () => {
      stmt.run();
    });

    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "SQL_QUERY",
        correlation_id: "corr-id-sql-test",
      })
    );
  });

  it("should NOT include correlation_id when not in context", () => {
    isLevelSpy = jest.spyOn(logger, "isLevelEnabled").mockReturnValue(true);
    debugSpy = jest.spyOn(logger, "debug");

    const fakeStmt = {
      run: jest.fn(() => ({ changes: 1 })),
    };
    const fakeDb = {
      prepare: jest.fn(() => fakeStmt),
    };

    const proxied = wrapDatabaseWithLogging(fakeDb);
    const stmt = proxied.prepare("SELECT 1");

    stmt.run();

    const logEntry = debugSpy.mock.calls[0][0];
    expect(logEntry.correlation_id).toBeUndefined();
  });
});
