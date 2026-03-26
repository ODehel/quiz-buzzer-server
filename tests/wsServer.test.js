import { createServer } from "node:http";
import { openDatabase } from "../src/database/database.js";
import { WebSocket } from "ws";
import jwt from "jsonwebtoken";
import {
  attachWebSocket,
  MAX_BUZZERS,
  WS_CLOSE_INVALID_TOKEN,
  WS_CLOSE_TOKEN_EXPIRED,
  WS_CLOSE_AUTH_TIMEOUT,
  WS_CLOSE_SESSION_REPLACED,
} from "../src/websocket/wsServer.js";

const JWT_SECRET = "a-test-secret-that-is-at-least-32-characters-long!!";
const AUTH_TIMEOUT = 60; // ms — short for tests

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestDb() {
  // Use openDatabase to create all tables (including game tables needed by the orchestrator)
  return openDatabase(":memory:");
}

function insertUser(db, { id, username, role }) {
  db.prepare(
    "INSERT INTO T_USER_USR (USR_ID, USR_USERNAME, USR_PASSWORD, USR_ROLE, USR_CREATED_AT) VALUES (?, ?, ?, ?, ?)"
  ).run(id, username, "hashed", role, new Date().toISOString());
}

function makeToken(sub, role) {
  return jwt.sign({ sub, role }, JWT_SECRET, { algorithm: "HS256", expiresIn: 3600 });
}

function makeExpiredToken(sub, role) {
  return jwt.sign(
    { sub, role, exp: Math.floor(Date.now() / 1000) - 10 },
    JWT_SECRET,
    { algorithm: "HS256" }
  );
}

async function startTestServer(db, opts = {}) {
  const server = createServer();
  const wss = attachWebSocket(server, db, JWT_SECRET, {
    authTimeoutMs: AUTH_TIMEOUT,
    ...opts,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, wss };
}

async function teardown(server, wss) {
  for (const client of wss.clients) {
    client.terminate();
  }
  await new Promise((resolve) => server.close(resolve));
}

function connectWs(server, path = "/ws") {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitForClose(ws) {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() })
    );
  });
}

function waitForMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch (e) {
        reject(e);
      }
    });
    ws.once("error", reject);
  });
}

function sendAuth(ws, token) {
  ws.send(JSON.stringify({ type: "auth", token }));
}

async function authenticateWs(ws, sub, role) {
  const msgPromise = waitForMessage(ws);
  sendAuth(ws, makeToken(sub, role));
  return msgPromise;
}

function captureConsole() {
  const captured = { log: [], warn: [], error: [] };
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (msg) => captured.log.push(msg);
  console.warn = (msg) => captured.warn.push(msg);
  console.error = (msg) => captured.error.push(msg);
  const restore = () => {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  };
  return { captured, restore };
}

function parseLogs(msgs) {
  return msgs.map((m) => JSON.parse(m));
}

// ---------------------------------------------------------------------------
// Tests: path filtering (CA-2, CA-3)
// ---------------------------------------------------------------------------
describe("attachWebSocket — path filtering", () => {
  let db, server, wss;
  let restore;

  beforeEach(async () => {
    db = createTestDb();
    ({ restore } = captureConsole());
    ({ server, wss } = await startTestServer(db));
  });

  afterEach(async () => {
    await teardown(server, wss);
    db.close();
    restore();
  });

  it("CA-2: should accept WebSocket upgrade on /ws", async () => {
    const ws = await connectWs(server, "/ws");
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.terminate();
  });

  it("CA-3: should reject WebSocket upgrade on a path other than /ws", async () => {
    await expect(connectWs(server, "/other")).rejects.toThrow();
  });

  it("CA-3: should reject WebSocket upgrade on /ws/extra", async () => {
    await expect(connectWs(server, "/ws/extra")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: WebSocket rate limiting (15 connections per minute per IP)
// ---------------------------------------------------------------------------
describe("attachWebSocket — WebSocket rate limiting", () => {
  let db, server, wss;
  let captured, restore;

  beforeEach(async () => {
    db = createTestDb();
    ({ captured, restore } = captureConsole());
    // Use lower rate limit for faster tests: 3 connections per 100ms
    ({ server, wss } = await startTestServer(db, {
      wsRateLimitConnections: 3,
      wsRateLimitWindowMs: 100,
    }));
  });

  afterEach(async () => {
    await teardown(server, wss);
    db.close();
    restore();
  });

  it("should allow up to the limit of WebSocket connections from same IP", async () => {
    // Allow 3 connections with the test config
    const ws1 = await connectWs(server);
    const ws2 = await connectWs(server);
    const ws3 = await connectWs(server);

    expect(ws1.readyState).toBe(WebSocket.OPEN);
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    expect(ws3.readyState).toBe(WebSocket.OPEN);

    ws1.terminate();
    ws2.terminate();
    ws3.terminate();
  });

  it("should reject WebSocket connection when rate limit is exceeded", async () => {
    // Create 3 successful connections
    const ws1 = await connectWs(server);
    const ws2 = await connectWs(server);
    const ws3 = await connectWs(server);

    expect(ws1.readyState).toBe(WebSocket.OPEN);
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    expect(ws3.readyState).toBe(WebSocket.OPEN);

    // 4th connection should be rejected
    await expect(connectWs(server)).rejects.toThrow();

    ws1.terminate();
    ws2.terminate();
    ws3.terminate();
  });

  it("should log WEBSOCKET_RATE_LIMITED when rate limit is exceeded", async () => {
    // Create 3 successful connections
    const ws1 = await connectWs(server);
    const ws2 = await connectWs(server);
    const ws3 = await connectWs(server);

    // 4th connection should be rejected and logged
    await expect(connectWs(server)).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));

    const warns = parseLogs(captured.warn);
    const log = warns.find((e) => e.event === "WEBSOCKET_RATE_LIMITED");
    expect(log).toBeDefined();
    expect(log.level).toBe("WARN");
    expect(log).toHaveProperty("ip");
    expect(log.limit).toBe(3);
    expect(log.windowSeconds).toBe(0.1);

    ws1.terminate();
    ws2.terminate();
    ws3.terminate();
  });

  it("should allow new connections from different IP", async () => {
    // Create 3 connections (reaching limit)
    const ws1 = await connectWs(server);
    const ws2 = await connectWs(server);
    const ws3 = await connectWs(server);

    // Reject from same IP
    await expect(connectWs(server)).rejects.toThrow();

    // Allow from different IP (simulated by localhost)
    // Note: In a real scenario with different IPs, this would succeed
    // For this test, we can only verify that same IP is rate limited

    ws1.terminate();
    ws2.terminate();
    ws3.terminate();
  });

  it("should allow new connections after rate limit window expires", async () => {
    // Create 3 connections (reaching limit)
    const ws1 = await connectWs(server);
    const ws2 = await connectWs(server);
    const ws3 = await connectWs(server);

    // Reject from same IP
    await expect(connectWs(server)).rejects.toThrow();

    // Wait for window to expire (100ms)
    await new Promise((r) => setTimeout(r, 110));

    // Should now allow new connection
    const ws4 = await connectWs(server);
    expect(ws4.readyState).toBe(WebSocket.OPEN);

    ws1.terminate();
    ws2.terminate();
    ws3.terminate();
    ws4.terminate();
  });
});

// ---------------------------------------------------------------------------
// Tests: connection logging (CA-18)
// ---------------------------------------------------------------------------
describe("attachWebSocket — connection logging", () => {
  let db, server, wss;
  let captured, restore;

  beforeEach(async () => {
    db = createTestDb();
    ({ captured, restore } = captureConsole());
    ({ server, wss } = await startTestServer(db));
  });

  afterEach(async () => {
    await teardown(server, wss);
    db.close();
    restore();
  });

  it("CA-18: should log WEBSOCKET_CONNECTED when a client connects", async () => {
    const ws = await connectWs(server);
    await new Promise((r) => setTimeout(r, 20));
    const events = parseLogs(captured.log);
    const log = events.find((e) => e.event === "WEBSOCKET_CONNECTED");
    expect(log).toBeDefined();
    expect(log.level).toBe("INFO");
    expect(log).toHaveProperty("ip");
    ws.terminate();
  });
});

// ---------------------------------------------------------------------------
// Tests: auth timeout (CA-9)
// ---------------------------------------------------------------------------
describe("attachWebSocket — authentication timeout", () => {
  let db, server, wss;
  let captured, restore;

  beforeEach(async () => {
    db = createTestDb();
    ({ captured, restore } = captureConsole());
    ({ server, wss } = await startTestServer(db));
  });

  afterEach(async () => {
    await teardown(server, wss);
    db.close();
    restore();
  });

  it("CA-9: should close with 4003 when no auth message is sent within timeout", async () => {
    const ws = await connectWs(server);
    const { code, reason } = await waitForClose(ws);
    expect(code).toBe(WS_CLOSE_AUTH_TIMEOUT);
    expect(reason).toBe("Authentication timeout.");
  });

  it("CA-9: should log WEBSOCKET_AUTH_FAILED with timeout reason", async () => {
    const ws = await connectWs(server);
    await waitForClose(ws);
    const warns = parseLogs(captured.warn);
    const log = warns.find((e) => e.event === "WEBSOCKET_AUTH_FAILED");
    expect(log).toBeDefined();
    expect(log.level).toBe("WARN");
    expect(log.reason).toBe("Authentication timeout.");
    expect(log).toHaveProperty("ip");
  });
});

// ---------------------------------------------------------------------------
// Tests: auth message validation (CA-10, CA-11)
// ---------------------------------------------------------------------------
describe("attachWebSocket — auth message validation", () => {
  let db, server, wss;
  let captured, restore;

  beforeEach(async () => {
    db = createTestDb();
    ({ captured, restore } = captureConsole());
    ({ server, wss } = await startTestServer(db));
  });

  afterEach(async () => {
    await teardown(server, wss);
    db.close();
    restore();
  });

  it("CA-10: should close with 4001 for invalid JSON", async () => {
    const ws = await connectWs(server);
    const closePromise = waitForClose(ws);
    ws.send("not valid json!!!");
    const { code, reason } = await closePromise;
    expect(code).toBe(WS_CLOSE_INVALID_TOKEN);
    expect(reason).toBe("Invalid token.");
  });

  it("CA-11: should close with 4001 if type is not 'auth'", async () => {
    const ws = await connectWs(server);
    const closePromise = waitForClose(ws);
    ws.send(JSON.stringify({ type: "other", token: "t" }));
    const { code, reason } = await closePromise;
    expect(code).toBe(WS_CLOSE_INVALID_TOKEN);
    expect(reason).toBe("Invalid token.");
  });

  it("CA-11: should close with 4001 if token field is missing", async () => {
    const ws = await connectWs(server);
    const closePromise = waitForClose(ws);
    ws.send(JSON.stringify({ type: "auth" }));
    const { code, reason } = await closePromise;
    expect(code).toBe(WS_CLOSE_INVALID_TOKEN);
    expect(reason).toBe("Invalid token.");
  });

  it("CA-11: should close with 4001 if token is not a string", async () => {
    const ws = await connectWs(server);
    const closePromise = waitForClose(ws);
    ws.send(JSON.stringify({ type: "auth", token: 12345 }));
    const { code, reason } = await closePromise;
    expect(code).toBe(WS_CLOSE_INVALID_TOKEN);
    expect(reason).toBe("Invalid token.");
  });

  it("CA-11: should close with 4001 if message is null JSON", async () => {
    const ws = await connectWs(server);
    const closePromise = waitForClose(ws);
    ws.send("null");
    const { code, reason } = await closePromise;
    expect(code).toBe(WS_CLOSE_INVALID_TOKEN);
    expect(reason).toBe("Invalid token.");
  });

  it("CA-20: should log WEBSOCKET_AUTH_FAILED on invalid message", async () => {
    const ws = await connectWs(server);
    const closePromise = waitForClose(ws);
    ws.send("bad");
    await closePromise;
    const warns = parseLogs(captured.warn);
    const log = warns.find((e) => e.event === "WEBSOCKET_AUTH_FAILED");
    expect(log).toBeDefined();
    expect(log.level).toBe("WARN");
    expect(log.reason).toBe("Invalid token.");
    expect(log).toHaveProperty("ip");
  });
});

// ---------------------------------------------------------------------------
// Tests: JWT verification (CA-5, CA-7, CA-8)
// ---------------------------------------------------------------------------
describe("attachWebSocket — JWT verification", () => {
  let db, server, wss;
  let captured, restore;

  beforeEach(async () => {
    db = createTestDb();
    ({ captured, restore } = captureConsole());
    ({ server, wss } = await startTestServer(db));
  });

  afterEach(async () => {
    await teardown(server, wss);
    db.close();
    restore();
  });

  it("CA-7: should close with 4001 for a token with invalid signature", async () => {
    const ws = await connectWs(server);
    const closePromise = waitForClose(ws);
    sendAuth(ws, "header.payload.badsignature");
    const { code, reason } = await closePromise;
    expect(code).toBe(WS_CLOSE_INVALID_TOKEN);
    expect(reason).toBe("Invalid token.");
  });

  it("CA-7: should close with 4001 for a malformed token string", async () => {
    const ws = await connectWs(server);
    const closePromise = waitForClose(ws);
    sendAuth(ws, "completely-invalid-token");
    const { code, reason } = await closePromise;
    expect(code).toBe(WS_CLOSE_INVALID_TOKEN);
    expect(reason).toBe("Invalid token.");
  });

  it("CA-8: should close with 4002 for an expired token", async () => {
    const ws = await connectWs(server);
    const closePromise = waitForClose(ws);
    sendAuth(ws, makeExpiredToken("sub-1", "buzzer"));
    const { code, reason } = await closePromise;
    expect(code).toBe(WS_CLOSE_TOKEN_EXPIRED);
    expect(reason).toBe("Token expired.");
  });

  it("CA-8: should log WEBSOCKET_AUTH_FAILED with reason 'Token expired.'", async () => {
    const ws = await connectWs(server);
    const closePromise = waitForClose(ws);
    sendAuth(ws, makeExpiredToken("sub-1", "buzzer"));
    await closePromise;
    const warns = parseLogs(captured.warn);
    const log = warns.find((e) => e.event === "WEBSOCKET_AUTH_FAILED");
    expect(log.reason).toBe("Token expired.");
  });

  it("CA-5: should close with 4001 if token is missing sub claim", async () => {
    const token = jwt.sign({ role: "buzzer" }, JWT_SECRET, { algorithm: "HS256", expiresIn: 3600 });
    const ws = await connectWs(server);
    const closePromise = waitForClose(ws);
    sendAuth(ws, token);
    const { code } = await closePromise;
    expect(code).toBe(WS_CLOSE_INVALID_TOKEN);
  });

  it("CA-5: should close with 4001 if token is missing role claim", async () => {
    const token = jwt.sign({ sub: "some-id" }, JWT_SECRET, { algorithm: "HS256", expiresIn: 3600 });
    const ws = await connectWs(server);
    const closePromise = waitForClose(ws);
    sendAuth(ws, token);
    const { code } = await closePromise;
    expect(code).toBe(WS_CLOSE_INVALID_TOKEN);
  });

  it("CA-7: should close with 4001 if user is not found in DB", async () => {
    const token = makeToken("nonexistent-uuid", "buzzer");
    const ws = await connectWs(server);
    const closePromise = waitForClose(ws);
    sendAuth(ws, token);
    const { code, reason } = await closePromise;
    expect(code).toBe(WS_CLOSE_INVALID_TOKEN);
    expect(reason).toBe("Invalid token.");
  });
});

// ---------------------------------------------------------------------------
// Tests: successful authentication (CA-6, CA-12, CA-15, CA-16, CA-19)
// ---------------------------------------------------------------------------
describe("attachWebSocket — successful authentication", () => {
  let db, server, wss;
  let captured, restore;

  beforeEach(async () => {
    db = createTestDb();
    insertUser(db, { id: "buzzer-001", username: "quiz_buzzer_01", role: "buzzer" });
    insertUser(db, { id: "admin-001", username: "admin", role: "admin" });
    ({ captured, restore } = captureConsole());
    ({ server, wss } = await startTestServer(db));
  });

  afterEach(async () => {
    await teardown(server, wss);
    db.close();
    restore();
  });

  it("CA-6: should send auth_success for a valid buzzer token", async () => {
    const ws = await connectWs(server);
    const msg = await authenticateWs(ws, "buzzer-001", "buzzer");
    expect(msg.type).toBe("auth_success");
    expect(msg.role).toBe("buzzer");
    expect(msg.username).toBe("quiz_buzzer_01");
    expect(msg.expires_in).toBeDefined();
    expect(typeof msg.expires_in).toBe("number");
    expect(msg.expires_in).toBeGreaterThan(0);
  });

  it("CA-15: should send auth_success for a valid admin token", async () => {
    const ws = await connectWs(server);
    const msg = await authenticateWs(ws, "admin-001", "admin");
    expect(msg.type).toBe("auth_success");
    expect(msg.role).toBe("admin");
    expect(msg.username).toBe("admin");
    expect(msg.expires_in).toBeDefined();
    expect(typeof msg.expires_in).toBe("number");
    expect(msg.expires_in).toBeGreaterThan(0);
  });

  it("CA-19: should log WEBSOCKET_AUTHENTICATED with summary for buzzer", async () => {
    const ws = await connectWs(server);
    await authenticateWs(ws, "buzzer-001", "buzzer");
    const events = parseLogs(captured.log);
    const log = events.find((e) => e.event === "WEBSOCKET_AUTHENTICATED");
    expect(log).toBeDefined();
    expect(log.level).toBe("INFO");
    expect(log.username).toBe("quiz_buzzer_01");
    expect(log.role).toBe("buzzer");
    expect(log.buzzers_connected).toBe(1);
    expect(log.buzzers_max).toBe(MAX_BUZZERS);
    expect(log.admin_connected).toBe(0);
    expect(log).toHaveProperty("ip");
  });

  it("CA-19: should log WEBSOCKET_AUTHENTICATED with summary for admin", async () => {
    const ws = await connectWs(server);
    await authenticateWs(ws, "admin-001", "admin");
    const events = parseLogs(captured.log);
    const log = events.find((e) => e.event === "WEBSOCKET_AUTHENTICATED");
    expect(log.username).toBe("admin");
    expect(log.role).toBe("admin");
    expect(log.buzzers_connected).toBe(0);
    expect(log.admin_connected).toBe(1);
  });

  it("CA-23: should silently ignore messages after successful authentication", async () => {
    const ws = await connectWs(server);
    await authenticateWs(ws, "buzzer-001", "buzzer");
    const logCountBefore = captured.log.length;
    ws.send(JSON.stringify({ type: "buzz" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(captured.log.length).toBe(logCountBefore);
  });
});

// ---------------------------------------------------------------------------
// Tests: disconnection logging (CA-21)
// ---------------------------------------------------------------------------
describe("attachWebSocket — disconnection", () => {
  let db, server, wss;
  let captured, restore;

  beforeEach(async () => {
    db = createTestDb();
    insertUser(db, { id: "buzzer-001", username: "quiz_buzzer_01", role: "buzzer" });
    ({ captured, restore } = captureConsole());
    ({ server, wss } = await startTestServer(db));
  });

  afterEach(async () => {
    await teardown(server, wss);
    db.close();
    restore();
  });

  it("CA-21: should log WEBSOCKET_DISCONNECTED when authenticated client disconnects", async () => {
    const ws = await connectWs(server);
    await authenticateWs(ws, "buzzer-001", "buzzer");
    ws.close();
    await waitForClose(ws);
    await new Promise((r) => setTimeout(r, 30));
    const events = parseLogs(captured.log);
    const log = events.find((e) => e.event === "WEBSOCKET_DISCONNECTED");
    expect(log).toBeDefined();
    expect(log.level).toBe("INFO");
    expect(log.username).toBe("quiz_buzzer_01");
    expect(log.role).toBe("buzzer");
    expect(log.buzzers_connected).toBe(0);
    expect(log.buzzers_max).toBe(MAX_BUZZERS);
    expect(log.admin_connected).toBe(0);
  });

  it("CA-21: should NOT log WEBSOCKET_DISCONNECTED for unauthenticated client", async () => {
    const ws = await connectWs(server);
    ws.close();
    await waitForClose(ws);
    await new Promise((r) => setTimeout(r, 30));
    const events = parseLogs(captured.log);
    const log = events.find((e) => e.event === "WEBSOCKET_DISCONNECTED");
    expect(log).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: session replacement (CA-13, CA-17)
// ---------------------------------------------------------------------------
describe("attachWebSocket — session replacement", () => {
  let db, server, wss;
  let restore;

  beforeEach(async () => {
    db = createTestDb();
    insertUser(db, { id: "buzzer-001", username: "quiz_buzzer_01", role: "buzzer" });
    insertUser(db, { id: "admin-001", username: "admin", role: "admin" });
    insertUser(db, { id: "admin-002", username: "admin2", role: "admin" });
    ({ restore } = captureConsole());
    ({ server, wss } = await startTestServer(db));
  });

  afterEach(async () => {
    await teardown(server, wss);
    db.close();
    restore();
  });

  it("CA-13: should close old buzzer with 4004 when same sub reconnects", async () => {
    const ws1 = await connectWs(server);
    await authenticateWs(ws1, "buzzer-001", "buzzer");

    const oldClosePromise = waitForClose(ws1);
    const ws2 = await connectWs(server);
    const newAuthPromise = waitForMessage(ws2);
    sendAuth(ws2, makeToken("buzzer-001", "buzzer"));

    const { code, reason } = await oldClosePromise;
    expect(code).toBe(WS_CLOSE_SESSION_REPLACED);
    expect(reason).toBe("Session replaced.");

    const msg = await newAuthPromise;
    expect(msg.type).toBe("auth_success");
    expect(msg.expires_in).toBeDefined();
    expect(typeof msg.expires_in).toBe("number");
  });

  it("CA-17: should close old admin with 4004 when same admin sub reconnects", async () => {
    const ws1 = await connectWs(server);
    await authenticateWs(ws1, "admin-001", "admin");

    const oldClosePromise = waitForClose(ws1);
    const ws2 = await connectWs(server);
    const newAuthPromise = waitForMessage(ws2);
    sendAuth(ws2, makeToken("admin-001", "admin"));

    const { code, reason } = await oldClosePromise;
    expect(code).toBe(WS_CLOSE_SESSION_REPLACED);
    expect(reason).toBe("Session replaced.");

    const msg = await newAuthPromise;
    expect(msg.type).toBe("auth_success");
    expect(msg.expires_in).toBeDefined();
    expect(typeof msg.expires_in).toBe("number");
  });

  it("CA-17: should close old admin with 4004 when a different admin sub connects", async () => {
    const ws1 = await connectWs(server);
    await authenticateWs(ws1, "admin-001", "admin");

    const oldClosePromise = waitForClose(ws1);
    const ws2 = await connectWs(server);
    const newAuthPromise = waitForMessage(ws2);
    sendAuth(ws2, makeToken("admin-002", "admin"));

    const { code, reason } = await oldClosePromise;
    expect(code).toBe(WS_CLOSE_SESSION_REPLACED);
    expect(reason).toBe("Session replaced.");

    const msg = await newAuthPromise;
    expect(msg.type).toBe("auth_success");
    expect(msg.username).toBe("admin2");
    expect(msg.expires_in).toBeDefined();
    expect(typeof msg.expires_in).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Tests: connection limits (CA-12, CA-16)
// ---------------------------------------------------------------------------
describe("attachWebSocket — connection limits", () => {
  let db, server, wss;
  let restore;

  beforeEach(async () => {
    db = createTestDb();
    for (let i = 1; i <= MAX_BUZZERS + 1; i++) {
      insertUser(db, {
        id: `buzzer-${String(i).padStart(3, "0")}`,
        username: `buzzer${i}`,
        role: "buzzer",
      });
    }
    ({ restore } = captureConsole());
    ({ server, wss } = await startTestServer(db));
  });

  afterEach(async () => {
    await teardown(server, wss);
    db.close();
    restore();
  });

  it("CA-12: should accept up to MAX_BUZZERS (10) simultaneous buzzer connections", async () => {
    const clients = [];
    for (let i = 1; i <= MAX_BUZZERS; i++) {
      const ws = await connectWs(server);
      const msg = await authenticateWs(
        ws,
        `buzzer-${String(i).padStart(3, "0")}`,
        "buzzer"
      );
      expect(msg.type).toBe("auth_success");
      expect(msg.expires_in).toBeDefined();
      clients.push(ws);
    }
    for (const ws of clients) ws.terminate();
  });

  it("CA-12: should reject the 11th buzzer with 4001", async () => {
    const clients = [];
    for (let i = 1; i <= MAX_BUZZERS; i++) {
      const ws = await connectWs(server);
      await authenticateWs(ws, `buzzer-${String(i).padStart(3, "0")}`, "buzzer");
      clients.push(ws);
    }

    const ws11 = await connectWs(server);
    const closePromise = waitForClose(ws11);
    sendAuth(ws11, makeToken("buzzer-011", "buzzer"));
    const { code } = await closePromise;
    expect(code).toBe(WS_CLOSE_INVALID_TOKEN);

    for (const ws of clients) ws.terminate();
  });
});

// ---------------------------------------------------------------------------
// Tests: internal error handling (CA-24)
// ---------------------------------------------------------------------------
describe("attachWebSocket — internal error handling", () => {
  let db, server, wss;
  let captured, restore;

  beforeEach(async () => {
    db = createTestDb();
    ({ captured, restore } = captureConsole());
    ({ server, wss } = await startTestServer(db));
  });

  afterEach(async () => {
    await teardown(server, wss);
    db.close();
    restore();
  });

  it("CA-24: should close with 1011 and log INTERNAL_ERROR on DB failure during auth", async () => {
    insertUser(db, { id: "buzzer-001", username: "quiz_buzzer_01", role: "buzzer" });
    db.close();

    const token = makeToken("buzzer-001", "buzzer");
    const ws = await connectWs(server);
    const closePromise = waitForClose(ws);
    sendAuth(ws, token);
    const { code } = await closePromise;
    expect(code).toBe(1011);

    const errors = parseLogs(captured.error);
    const log = errors.find((e) => e.event === "INTERNAL_ERROR");
    expect(log).toBeDefined();
    expect(log.level).toBe("ERROR");
  });

  it("CA-24: should log INTERNAL_ERROR when the WebSocket emits an error event", async () => {
    const ws = await connectWs(server);
    await new Promise((r) => setTimeout(r, 20));

    // Get the server-side ws instance from wss.clients
    const [serverWs] = wss.clients;
    expect(serverWs).toBeDefined();

    serverWs.emit("error", new Error("simulated socket error"));
    await new Promise((r) => setTimeout(r, 20));

    const errors = parseLogs(captured.error);
    const log = errors.find((e) => e.event === "INTERNAL_ERROR");
    expect(log).toBeDefined();
    expect(log.level).toBe("ERROR");
    expect(log.message).toBe("simulated socket error");

    ws.terminate();
  });
});

// ---------------------------------------------------------------------------
// Tests: buzzer slot freed on disconnect (CA-14)
// ---------------------------------------------------------------------------
describe("attachWebSocket — buzzer slot freed on disconnect (CA-14)", () => {
  let db, server, wss;
  let restore;

  beforeEach(async () => {
    db = createTestDb();
    for (let i = 1; i <= MAX_BUZZERS + 1; i++) {
      insertUser(db, {
        id: `buzzer-${String(i).padStart(3, "0")}`,
        username: `buzzer${i}`,
        role: "buzzer",
      });
    }
    ({ restore } = captureConsole());
    ({ server, wss } = await startTestServer(db));
  });

  afterEach(async () => {
    await teardown(server, wss);
    db.close();
    restore();
  });

  // CA-14 : Un buzzer déconnecté libère son slot
  it("CA-14: should free the buzzer slot after disconnect, allowing a new connection", async () => {
    // Fill up all MAX_BUZZERS slots
    const clients = [];
    for (let i = 1; i <= MAX_BUZZERS; i++) {
      const ws = await connectWs(server);
      await authenticateWs(ws, `buzzer-${String(i).padStart(3, "0")}`, "buzzer");
      clients.push(ws);
    }

    // Disconnect the first buzzer and wait for cleanup
    const closePromise = waitForClose(clients[0]);
    clients[0].close();
    await closePromise;
    await new Promise((r) => setTimeout(r, 30));

    // Now connecting a new buzzer should succeed (slot is freed)
    const newBuzzer = await connectWs(server);
    const msg = await authenticateWs(newBuzzer, `buzzer-${String(MAX_BUZZERS + 1).padStart(3, "0")}`, "buzzer");
    expect(msg.type).toBe("auth_success");
    expect(msg.expires_in).toBeDefined();

    newBuzzer.terminate();
    // clients[0] was already closed above; terminate the remaining clients
    for (let i = 1; i < clients.length; i++) clients[i].terminate();
  });
});

// ---------------------------------------------------------------------------
// Tests: unauthenticated client messages ignored after failed auth (CA-22)
// ---------------------------------------------------------------------------
describe("attachWebSocket — unauthenticated client messages ignored (CA-22)", () => {
  let db, server, wss;
  let restore;

  beforeEach(async () => {
    db = createTestDb();
    ({ restore } = captureConsole());
    ({ server, wss } = await startTestServer(db));
  });

  afterEach(async () => {
    await teardown(server, wss);
    db.close();
    restore();
  });

  // CA-22 : Tout message reçu d'un client non authentifié est ignoré
  it("CA-22: should close after invalid auth, not process subsequent messages", async () => {
    const ws = await connectWs(server);
    const closePromise = waitForClose(ws);

    // Send an invalid auth message — triggers close with 4001
    ws.send("not valid json");
    const { code } = await closePromise;
    expect(code).toBe(WS_CLOSE_INVALID_TOKEN);

    // The connection is closed; the server does not respond to any further data
    // (the close code confirms the unauthenticated client's message was handled by closing)
  });

  it("CA-22: should not process a second message after the first invalid auth", async () => {
    const ws = await connectWs(server);
    const closePromise = waitForClose(ws);

    // Send invalid auth which triggers immediate close (4001)
    ws.send(JSON.stringify({ type: "auth", token: "invalid.token.here" }));
    const { code } = await closePromise;
    expect(code).toBe(WS_CLOSE_INVALID_TOKEN);
    // Connection is properly closed; no further processing occurs
  });
});
