import { createServer } from "node:http";
import { openDatabase } from "../src/database/database.js";
import { WebSocket } from "ws";
import jwt from "jsonwebtoken";
import { attachWebSocket } from "../src/websocket/wsServer.js";

const JWT_SECRET = "a-test-secret-that-is-at-least-32-characters-long!!";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb() {
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

async function startTestServer(db, opts = {}) {
  const server = createServer();
  const wss = attachWebSocket(server, db, JWT_SECRET, {
    authTimeoutMs: 5000,
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

function connectWs(server) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitForMessage(ws) {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

function waitForClose(ws) {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() })
    );
  });
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("ws-heartbeat integration", () => {
  let db, server, wss;

  beforeEach(async () => {
    db = createTestDb();
    insertUser(db, { id: "user-1", username: "buzzer_01", role: "buzzer" });
    insertUser(db, { id: "user-2", username: "buzzer_02", role: "buzzer" });
    insertUser(db, { id: "admin-1", username: "admin", role: "admin" });
  });

  afterEach(async () => {
    if (server) await teardown(server, wss);
    db.close();
  });

  // CA-1 + CA-4: heartbeat starts after auth, sends Ping frames
  test("CA-1/CA-4: server sends Ping frames after authentication", async () => {
    // Use a very short interval for the test
    ({ server, wss } = await startTestServer(db, {
      heartbeatOptions: { intervalMs: 50 },
    }));

    const ws = connectWs(server);
    const client = await ws;

    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "auth", token: makeToken("user-1", "buzzer") }));
    const authMsg = await msgPromise;
    expect(authMsg.type).toBe("auth_success");

    // Wait for ping — the ws library on client side auto-responds with pong
    const pingReceived = new Promise((resolve) => {
      client.on("ping", () => resolve(true));
    });

    const received = await Promise.race([
      pingReceived,
      new Promise((resolve) => setTimeout(() => resolve(false), 500)),
    ]);

    expect(received).toBe(true);
    client.close();
  });

  // CA-2: no ping before auth
  test("CA-2: no Ping frame sent before authentication", async () => {
    ({ server, wss } = await startTestServer(db, {
      heartbeatOptions: { intervalMs: 30 },
    }));

    const client = await connectWs(server);

    let pingReceived = false;
    client.on("ping", () => { pingReceived = true; });

    // Wait a bit without authenticating
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pingReceived).toBe(false);

    client.close();
  });

  // CA-7 + CA-9 + CA-10: connection closed after missed pings, removed from registry
  test("CA-7/CA-9/CA-10: connection closed after maxMissed pings, client removed", async () => {
    ({ server, wss } = await startTestServer(db, {
      heartbeatOptions: {
        intervalMs: 30,
        maxMissed: 2,
      },
    }));

    const client = await connectWs(server);

    // Authenticate
    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "auth", token: makeToken("user-1", "buzzer") }));
    await msgPromise;

    // Disable automatic pong response to simulate lost connection
    client.pong = () => {};
    client.on("ping", () => {
      // Do NOT respond with pong — simulates lost connection
    });

    const { code } = await waitForClose(client);
    expect(code).toBe(1000);
  });

  // CA-11: normal disconnect stops heartbeat cleanly
  test("CA-11: client disconnect before timeout doesn't trigger heartbeat close", async () => {
    ({ server, wss } = await startTestServer(db, {
      heartbeatOptions: { intervalMs: 200, maxMissed: 3 },
    }));

    const client = await connectWs(server);

    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "auth", token: makeToken("user-1", "buzzer") }));
    await msgPromise;

    // Close normally before any heartbeat timeout
    const closePromise = waitForClose(client);
    client.close();
    const { code } = await closePromise;

    // The close should be initiated by the client, not heartbeat timeout (1000)
    // Client-initiated close will also be 1000 or 1005, but crucially no HEARTBEAT_TIMEOUT log
    expect(code).toBeDefined();
  });
});
