import { jest } from "@jest/globals";
import jwt from "jsonwebtoken";

// ---------------------------------------------------------------------------
// Mock logger — must be set up BEFORE importing the module
// ---------------------------------------------------------------------------
jest.unstable_mockModule("../src/utils/logger.js", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

const { logInfo, logWarn, logError } = await import("../src/utils/logger.js");
const {
  scheduleTokenTimers,
  clearTokenTimers,
  handleAuthRefresh,
  TOKEN_EXPIRING_SOON_SECONDS,
} = await import("../src/websocket/tokenRefreshHandler.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const JWT_SECRET = "test-secret-key";

function createMockWs() {
  const sentMessages = [];
  return {
    readyState: 1, // WebSocket.OPEN
    send: jest.fn((data) => sentMessages.push(JSON.parse(data))),
    close: jest.fn(),
    _sentMessages: sentMessages,
  };
}

function createFakeTimers() {
  const timeouts = [];
  return {
    timeouts,
    setTimeoutFn: jest.fn((cb, ms) => {
      const id = { cb, ms, cleared: false };
      timeouts.push(id);
      return id;
    }),
    clearTimeoutFn: jest.fn((id) => {
      if (id) id.cleared = true;
    }),
    /** Fire a specific timeout by index */
    fire(index) {
      const t = timeouts[index];
      if (t && !t.cleared) t.cb();
    },
    /** Fire the token_expiring_soon timer (first scheduled) */
    fireExpiringSoon() { this.fire(0); },
    /** Fire the token_expired timer (second scheduled) */
    fireExpired() { this.fire(1); },
  };
}

function createToken(overrides = {}, expiresIn = 3600) {
  const payload = {
    sub: "user-uuid-1",
    role: "buzzer",
    ...overrides,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

function createExpiredToken(overrides = {}) {
  const payload = {
    sub: "user-uuid-1",
    role: "buzzer",
    ...overrides,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: -10 });
}

function createRegistry(ws, overrides = {}) {
  const registry = new Map();
  const entry = {
    ws,
    role: "buzzer",
    username: "quiz_buzzer_01",
    connectedAt: new Date().toISOString(),
    ...overrides,
  };
  registry.set("user-uuid-1", entry);
  return { registry, entry };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ===========================================================================
// scheduleTokenTimers
// ===========================================================================

describe("scheduleTokenTimers", () => {
  // CA-1: timer scheduled at exp - now - 300s
  test("CA-1 — schedules expiring_soon timer with correct delay", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry, entry } = createRegistry(ws);
    const exp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

    scheduleTokenTimers(ws, entry, exp, registry, "user-uuid-1", timers);

    expect(timers.setTimeoutFn).toHaveBeenCalledTimes(2);
    const expiringSoonDelay = timers.timeouts[0].ms;
    // Should be approximately (3600 - 300) * 1000 = 3_300_000 ms
    expect(expiringSoonDelay).toBeGreaterThan(3_299_000);
    expect(expiringSoonDelay).toBeLessThanOrEqual(3_300_000);
  });

  // CA-1 edge case: token already close to expiration → delay is 0
  test("CA-1 — sends token_expiring_soon immediately if exp - now < 300s", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry, entry } = createRegistry(ws);
    const exp = Math.floor(Date.now() / 1000) + 100; // only 100s left

    scheduleTokenTimers(ws, entry, exp, registry, "user-uuid-1", timers);

    // Delay should be 0 (Math.max(0, ...))
    expect(timers.timeouts[0].ms).toBe(0);
  });

  // CA-2: token_expiring_soon message format
  test("CA-2 — sends token_expiring_soon with correct format when timer fires", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry, entry } = createRegistry(ws);
    const exp = Math.floor(Date.now() / 1000) + 3600;

    scheduleTokenTimers(ws, entry, exp, registry, "user-uuid-1", timers);
    timers.fireExpiringSoon();

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws._sentMessages[0]).toEqual({
      type: "token_expiring_soon",
      expires_in: TOKEN_EXPIRING_SOON_SECONDS,
    });
  });

  // CA-3: only sent to the specific client (implicit — we only call ws.send on the given ws)
  test("CA-3 — token_expiring_soon sent only to the specific client", () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    const timers = createFakeTimers();
    const { registry, entry } = createRegistry(ws1);
    // Add another client to registry
    registry.set("user-uuid-2", { ws: ws2, role: "admin", username: "admin01" });

    const exp = Math.floor(Date.now() / 1000) + 3600;
    scheduleTokenTimers(ws1, entry, exp, registry, "user-uuid-1", timers);
    timers.fireExpiringSoon();

    expect(ws1.send).toHaveBeenCalledTimes(1);
    expect(ws2.send).not.toHaveBeenCalled();
  });

  // CA-4: disconnect before timer → timer cleared (tested via clearTokenTimers)
  test("CA-4 — clearTokenTimers cancels both timers", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry, entry } = createRegistry(ws);
    const exp = Math.floor(Date.now() / 1000) + 3600;

    scheduleTokenTimers(ws, entry, exp, registry, "user-uuid-1", timers);
    clearTokenTimers(entry, timers);

    expect(timers.clearTimeoutFn).toHaveBeenCalledTimes(4); // 2 from schedule (clear previous) + 2 from clearTokenTimers
    expect(entry.tokenExpiringSoonTimer).toBeUndefined();
    expect(entry.tokenExpiredTimer).toBeUndefined();
  });

  // CA-4: firing timers after clear does nothing
  test("CA-4 — no send on closed connection after timer fires", () => {
    const ws = createMockWs();
    ws.readyState = 3; // CLOSED
    const timers = createFakeTimers();
    const { registry, entry } = createRegistry(ws);
    const exp = Math.floor(Date.now() / 1000) + 3600;

    scheduleTokenTimers(ws, entry, exp, registry, "user-uuid-1", timers);
    timers.fireExpiringSoon();
    timers.fireExpired();

    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
  });

  // CA-5: expiration timer scheduled at exp - now
  test("CA-5 — schedules expired timer with correct delay", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry, entry } = createRegistry(ws);
    const exp = Math.floor(Date.now() / 1000) + 3600;

    scheduleTokenTimers(ws, entry, exp, registry, "user-uuid-1", timers);

    const expiredDelay = timers.timeouts[1].ms;
    expect(expiredDelay).toBeGreaterThan(3_599_000);
    expect(expiredDelay).toBeLessThanOrEqual(3_600_000);
  });

  // CA-6: token_expired message format
  test("CA-6 — sends token_expired when expiration timer fires", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry, entry } = createRegistry(ws);
    const exp = Math.floor(Date.now() / 1000) + 3600;

    scheduleTokenTimers(ws, entry, exp, registry, "user-uuid-1", timers);
    timers.fireExpired();

    expect(ws._sentMessages[0]).toEqual({ type: "token_expired" });
  });

  // CA-7: close with code 4002 after token_expired
  test("CA-7 — closes connection with 4002 after token_expired", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry, entry } = createRegistry(ws);
    const exp = Math.floor(Date.now() / 1000) + 3600;

    scheduleTokenTimers(ws, entry, exp, registry, "user-uuid-1", timers);
    timers.fireExpired();

    expect(ws.close).toHaveBeenCalledWith(4002, "Token expired.");
  });

  // CA-9: no send on already-closed connection when expired timer fires
  test("CA-9 — expired timer does not send on closed connection", () => {
    const ws = createMockWs();
    ws.readyState = 3; // CLOSED
    const timers = createFakeTimers();
    const { registry, entry } = createRegistry(ws);
    const exp = Math.floor(Date.now() / 1000) + 3600;

    scheduleTokenTimers(ws, entry, exp, registry, "user-uuid-1", timers);
    timers.fireExpired();

    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
  });

  // Logging
  test("logs WEBSOCKET_TOKEN_EXPIRING_SOON when warning timer fires", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry, entry } = createRegistry(ws);
    const exp = Math.floor(Date.now() / 1000) + 3600;

    scheduleTokenTimers(ws, entry, exp, registry, "user-uuid-1", timers);
    timers.fireExpiringSoon();

    expect(logInfo).toHaveBeenCalledWith("WEBSOCKET_TOKEN_EXPIRING_SOON", expect.objectContaining({
      username: "quiz_buzzer_01",
      role: "buzzer",
      expires_in: TOKEN_EXPIRING_SOON_SECONDS,
    }));
  });

  test("logs WEBSOCKET_TOKEN_EXPIRED when expired timer fires", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry, entry } = createRegistry(ws);
    const exp = Math.floor(Date.now() / 1000) + 3600;

    scheduleTokenTimers(ws, entry, exp, registry, "user-uuid-1", timers);
    timers.fireExpired();

    expect(logWarn).toHaveBeenCalledWith("WEBSOCKET_TOKEN_EXPIRED", expect.objectContaining({
      username: "quiz_buzzer_01",
      role: "buzzer",
    }));
  });
});

// ===========================================================================
// clearTokenTimers
// ===========================================================================

describe("clearTokenTimers", () => {
  test("safely handles null/undefined entry", () => {
    const timers = createFakeTimers();
    expect(() => clearTokenTimers(null, timers)).not.toThrow();
    expect(() => clearTokenTimers(undefined, timers)).not.toThrow();
  });

  test("safely handles entry without timers", () => {
    const timers = createFakeTimers();
    const entry = { ws: createMockWs(), role: "buzzer" };
    expect(() => clearTokenTimers(entry, timers)).not.toThrow();
  });
});

// ===========================================================================
// handleAuthRefresh
// ===========================================================================

describe("handleAuthRefresh", () => {
  // CA-10: valid token, matching sub and role → success
  test("CA-10/CA-11 — valid refresh reprograms timers and sends auth_success", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry } = createRegistry(ws);
    const token = createToken();

    handleAuthRefresh(
      { type: "auth_refresh", token },
      ws, "user-uuid-1", registry, JWT_SECRET, timers
    );

    // Should send auth_success
    const authSuccess = ws._sentMessages.find((m) => m.type === "auth_success");
    expect(authSuccess).toBeDefined();
    expect(authSuccess.role).toBe("buzzer");
    expect(authSuccess.username).toBe("quiz_buzzer_01");
    expect(authSuccess.expires_in).toBeGreaterThan(0);

    // Should have scheduled new timers
    expect(timers.setTimeoutFn).toHaveBeenCalledTimes(2);
  });

  // CA-11: timers are reprogrammed (old ones cleared)
  test("CA-11 — clears old timers before scheduling new ones", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry, entry } = createRegistry(ws);

    // Set fake existing timers
    entry.tokenExpiringSoonTimer = { fake: true };
    entry.tokenExpiredTimer = { fake: true };

    const token = createToken();
    handleAuthRefresh(
      { type: "auth_refresh", token },
      ws, "user-uuid-1", registry, JWT_SECRET, timers
    );

    // clearTimeoutFn should have been called for old timers
    expect(timers.clearTimeoutFn).toHaveBeenCalled();
  });

  // CA-12: sub mismatch → TOKEN_MISMATCH, close 4001
  test("CA-12 — sub mismatch sends TOKEN_MISMATCH and closes 4001", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry } = createRegistry(ws);

    const token = createToken({ sub: "different-uuid" });
    handleAuthRefresh(
      { type: "auth_refresh", token },
      ws, "user-uuid-1", registry, JWT_SECRET, timers
    );

    const error = ws._sentMessages.find((m) => m.type === "error");
    expect(error.code).toBe("TOKEN_MISMATCH");
    expect(error.message).toBe("Token identity does not match the current session.");
    expect(ws.close).toHaveBeenCalledWith(4001, "Invalid token.");
  });

  // CA-13: role mismatch → TOKEN_MISMATCH, close 4001
  test("CA-13 — role mismatch sends TOKEN_MISMATCH and closes 4001", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry } = createRegistry(ws);

    const token = createToken({ role: "admin" }); // registry has "buzzer"
    handleAuthRefresh(
      { type: "auth_refresh", token },
      ws, "user-uuid-1", registry, JWT_SECRET, timers
    );

    const error = ws._sentMessages.find((m) => m.type === "error");
    expect(error.code).toBe("TOKEN_MISMATCH");
    expect(ws.close).toHaveBeenCalledWith(4001, "Invalid token.");
  });

  // CA-14: expired token → TOKEN_EXPIRED, close 4002
  test("CA-14 — expired token sends TOKEN_EXPIRED and closes 4002", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry } = createRegistry(ws);

    const token = createExpiredToken();
    handleAuthRefresh(
      { type: "auth_refresh", token },
      ws, "user-uuid-1", registry, JWT_SECRET, timers
    );

    const error = ws._sentMessages.find((m) => m.type === "error");
    expect(error.code).toBe("TOKEN_EXPIRED");
    expect(error.message).toBe("The provided token has already expired.");
    expect(ws.close).toHaveBeenCalledWith(4002, "Token expired.");
  });

  // CA-15: invalid signature → TOKEN_INVALID, close 4001
  test("CA-15 — invalid signature sends TOKEN_INVALID and closes 4001", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry } = createRegistry(ws);

    const token = jwt.sign({ sub: "user-uuid-1", role: "buzzer" }, "wrong-secret", { expiresIn: 3600 });
    handleAuthRefresh(
      { type: "auth_refresh", token },
      ws, "user-uuid-1", registry, JWT_SECRET, timers
    );

    const error = ws._sentMessages.find((m) => m.type === "error");
    expect(error.code).toBe("TOKEN_INVALID");
    expect(error.message).toBe("The provided token is invalid.");
    expect(ws.close).toHaveBeenCalledWith(4001, "Invalid token.");
  });

  // CA-16: missing token field → INVALID_MESSAGE, connection stays open
  test("CA-16 — missing token field sends INVALID_MESSAGE, no close", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry } = createRegistry(ws);

    handleAuthRefresh(
      { type: "auth_refresh" }, // no token
      ws, "user-uuid-1", registry, JWT_SECRET, timers
    );

    const error = ws._sentMessages.find((m) => m.type === "error");
    expect(error.code).toBe("INVALID_MESSAGE");
    expect(ws.close).not.toHaveBeenCalled();
  });

  // CA-17: token field is not a string → INVALID_MESSAGE, connection stays open
  test("CA-17 — non-string token sends INVALID_MESSAGE, no close", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry } = createRegistry(ws);

    handleAuthRefresh(
      { type: "auth_refresh", token: 12345 },
      ws, "user-uuid-1", registry, JWT_SECRET, timers
    );

    const error = ws._sentMessages.find((m) => m.type === "error");
    expect(error.code).toBe("INVALID_MESSAGE");
    expect(ws.close).not.toHaveBeenCalled();
  });

  // CA-18: auth_refresh from unauthenticated client (not in registry) → ignored, WARN
  test("CA-18 — unauthenticated client is ignored with WARN", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const registry = new Map(); // empty registry

    handleAuthRefresh(
      { type: "auth_refresh", token: "anything" },
      ws, "user-uuid-1", registry, JWT_SECRET, timers
    );

    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith("WEBSOCKET_TOKEN_REFRESH_IGNORED", expect.objectContaining({
      reason: "Client not authenticated",
    }));
  });

  // CA-19: heartbeat timers not reset (implicit — we don't touch heartbeat timers)
  test("CA-19 — auth_refresh does not affect heartbeat (no heartbeat calls)", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry } = createRegistry(ws);
    const token = createToken();

    handleAuthRefresh(
      { type: "auth_refresh", token },
      ws, "user-uuid-1", registry, JWT_SECRET, timers
    );

    // Only token timers are set (2 calls), no heartbeat interference
    expect(timers.setTimeoutFn).toHaveBeenCalledTimes(2);
  });

  // Logging: successful refresh
  test("logs WEBSOCKET_TOKEN_REFRESHED on successful refresh", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry } = createRegistry(ws);
    const token = createToken();

    handleAuthRefresh(
      { type: "auth_refresh", token },
      ws, "user-uuid-1", registry, JWT_SECRET, timers
    );

    expect(logInfo).toHaveBeenCalledWith("WEBSOCKET_TOKEN_REFRESHED", {
      username: "quiz_buzzer_01",
      role: "buzzer",
    });
  });

  // Logging: failed refresh (mismatch)
  test("logs WEBSOCKET_TOKEN_REFRESH_FAILED on mismatch", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry } = createRegistry(ws);
    const token = createToken({ sub: "different-uuid" });

    handleAuthRefresh(
      { type: "auth_refresh", token },
      ws, "user-uuid-1", registry, JWT_SECRET, timers
    );

    expect(logWarn).toHaveBeenCalledWith("WEBSOCKET_TOKEN_REFRESH_FAILED", expect.objectContaining({
      reason: "TOKEN_MISMATCH",
    }));
  });

  // Logging: failed refresh (expired)
  test("logs WEBSOCKET_TOKEN_REFRESH_FAILED on expired token", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry } = createRegistry(ws);
    const token = createExpiredToken();

    handleAuthRefresh(
      { type: "auth_refresh", token },
      ws, "user-uuid-1", registry, JWT_SECRET, timers
    );

    expect(logWarn).toHaveBeenCalledWith("WEBSOCKET_TOKEN_REFRESH_FAILED", expect.objectContaining({
      reason: "TOKEN_EXPIRED",
    }));
  });

  // Logging: failed refresh (invalid)
  test("logs WEBSOCKET_TOKEN_REFRESH_FAILED on invalid signature", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry } = createRegistry(ws);
    const token = jwt.sign({ sub: "user-uuid-1", role: "buzzer" }, "wrong-secret");

    handleAuthRefresh(
      { type: "auth_refresh", token },
      ws, "user-uuid-1", registry, JWT_SECRET, timers
    );

    expect(logWarn).toHaveBeenCalledWith("WEBSOCKET_TOKEN_REFRESH_FAILED", expect.objectContaining({
      reason: "TOKEN_INVALID",
    }));
  });

  // CA-17: token is null → INVALID_MESSAGE
  test("null token sends INVALID_MESSAGE, no close", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry } = createRegistry(ws);

    handleAuthRefresh(
      { type: "auth_refresh", token: null },
      ws, "user-uuid-1", registry, JWT_SECRET, timers
    );

    const error = ws._sentMessages.find((m) => m.type === "error");
    expect(error.code).toBe("INVALID_MESSAGE");
    expect(ws.close).not.toHaveBeenCalled();
  });

  // CA-17: token is empty string → treated as invalid message
  test("empty string token sends INVALID_MESSAGE, no close", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const { registry } = createRegistry(ws);

    handleAuthRefresh(
      { type: "auth_refresh", token: "" },
      ws, "user-uuid-1", registry, JWT_SECRET, timers
    );

    const error = ws._sentMessages.find((m) => m.type === "error");
    expect(error.code).toBe("INVALID_MESSAGE");
    expect(ws.close).not.toHaveBeenCalled();
  });

  // Admin role refresh
  test("successful refresh for admin role", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const registry = new Map();
    registry.set("admin-uuid", {
      ws,
      role: "admin",
      username: "game_master",
      connectedAt: new Date().toISOString(),
    });

    const token = createToken({ sub: "admin-uuid", role: "admin" });
    handleAuthRefresh(
      { type: "auth_refresh", token },
      ws, "admin-uuid", registry, JWT_SECRET, timers
    );

    const authSuccess = ws._sentMessages.find((m) => m.type === "auth_success");
    expect(authSuccess.role).toBe("admin");
    expect(authSuccess.username).toBe("game_master");
    expect(ws.close).not.toHaveBeenCalled();
  });
});
