/**
 * Tests for US-011 — WebSocket game message handling.
 * Covers CA-38, CA-39, CA-41, CA-42, CA-43, and the full MCQ workflow
 * wired through the WebSocket server.
 */

import { createServer } from "node:http";
import { jest } from "@jest/globals";
import { openDatabase } from "../../src/database/database.js";
import { WebSocket } from "ws";
import jwt from "jsonwebtoken";
import { attachWebSocket } from "../../src/websocket/wsServer.js";
import { recoverInterruptedGame } from "../../src/game/gameRecovery.js";
import logger from "../../src/config/logger.js";

const JWT_SECRET = "a-test-secret-that-is-at-least-32-characters-long!!";

// ---------------------------------------------------------------------------
// Prevent leaked timers and sockets from blocking Jest worker exit.
//
// All setTimeout/setInterval calls are wrapped with .unref() so that game
// timers, heartbeat intervals, token-refresh timeouts, and retry delays can
// never keep the event loop alive on their own.
//
// After all tests, a deferred (0 ms, unref'd) callback unrefs every remaining
// active handle.  The callback fires *after* Jest's own post-test bookkeeping
// for this file (result/coverage reporting) has completed — it only runs
// because the lingering handles themselves keep the event loop alive long
// enough.  Once the handles are unref'd, the worker can exit cleanly.
// ---------------------------------------------------------------------------
const _origSetTimeout = globalThis.setTimeout;
const _origSetInterval = globalThis.setInterval;

globalThis.setTimeout = (fn, ms, ...args) => _origSetTimeout(fn, ms, ...args).unref();
globalThis.setInterval = (fn, ms, ...args) => _origSetInterval(fn, ms, ...args).unref();

afterAll(() => {
  globalThis.setTimeout = _origSetTimeout;
  globalThis.setInterval = _origSetInterval;

  // Deferred: runs on the next event-loop turn, after Jest finishes processing
  // this file's results.  Only unrefs TCP sockets and closed HTTP servers from
  // our tests — Pipe handles (Jest IPC) are left alone to avoid crashing
  // workers that Jest may reuse for other test files.
  _origSetTimeout(() => {
    for (const h of process._getActiveHandles()) {
      const handleType = h?._handle?.constructor?.name;
      // TCP sockets from WebSocket connections (not Pipe = Jest IPC)
      if (handleType === "TCP" && typeof h.unref === "function") {
        h.unref();
      }
      // Closed HTTP servers (listening=false, _handle already gone)
      if (
        h?.constructor?.name === "Server" &&
        h.listening === false &&
        typeof h.unref === "function"
      ) {
        h.unref();
      }
    }
  }, 0).unref();
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestDb() {
  const db = openDatabase(":memory:");

  db.prepare(
    `INSERT INTO T_THEME_THM (THM_ID, THM_NAME, THM_CREATED_AT) VALUES (?, ?, ?)`
  ).run("thm-1", "Science", "2026-03-17T10:00:00.000Z");

  // 3 MCQ questions
  for (let i = 1; i <= 3; i++) {
    db.prepare(
      `INSERT INTO T_QUESTION_QST
         (QST_ID, QST_TYPE, QST_THEME_ID, QST_TITLE,
          QST_CHOICE_A, QST_CHOICE_B, QST_CHOICE_C, QST_CHOICE_D,
          QST_CORRECT_ANSWER, QST_LEVEL, QST_TIME_LIMIT, QST_POINTS, QST_CREATED_AT)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `qst-${i}`, "MCQ", "thm-1",
      `Question ${i} de test ?`,
      "Paris", "Lyon", "Marseille", "Toulouse",
      "Paris", 1, 5, 10, "2026-03-17T10:00:00.000Z"
    );
  }

  db.prepare(
    `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT) VALUES (?, ?, ?)`
  ).run("quiz-1", "Mon quiz", "2026-03-17T10:00:00.000Z");

  for (let i = 1; i <= 3; i++) {
    db.prepare(
      `INSERT INTO T_QUIZ_QUESTION_QQN (QQN_QUIZ_ID, QQN_QUESTION_ID, QQN_ORDER) VALUES (?, ?, ?)`
    ).run("quiz-1", `qst-${i}`, i);
  }

  // Game in OPEN state
  db.prepare(
    `INSERT INTO T_GAME_GAM (GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CURRENT_QUESTION_INDEX, GAM_CREATED_AT)
     VALUES (?, ?, 'OPEN', 0, ?)`
  ).run("gam-1", "quiz-1", "2026-03-17T10:00:00.000Z");

  // Participants: Alice (1), Bob (2), Charlie (3)
  for (const [i, name] of [[1, "Alice"], [2, "Bob"], [3, "Charlie"]]) {
    db.prepare(
      `INSERT INTO T_GAME_PARTICIPANT_GPA (GPA_GAME_ID, GPA_NAME, GPA_ORDER) VALUES (?, ?, ?)`
    ).run("gam-1", name, i);
  }

  // Users: admin + 3 buzzers (username = participant name for mapping)
  db.prepare(
    `INSERT INTO T_USER_USR (USR_ID, USR_USERNAME, USR_PASSWORD, USR_ROLE, USR_CREATED_AT)
     VALUES (?, ?, ?, ?, ?)`
  ).run("admin-1", "admin", "hashed", "admin", "2026-03-17T10:00:00.000Z");

  for (const [i, name] of [[1, "Alice"], [2, "Bob"], [3, "Charlie"]]) {
    db.prepare(
      `INSERT INTO T_USER_USR (USR_ID, USR_USERNAME, USR_PASSWORD, USR_ROLE, USR_CREATED_AT)
       VALUES (?, ?, ?, ?, ?)`
    ).run(`buzzer-${i}`, name, "hashed", "buzzer", "2026-03-17T10:00:00.000Z");
  }

  return db;
}

function makeToken(sub, role) {
  return jwt.sign({ sub, role }, JWT_SECRET, { algorithm: "HS256", expiresIn: 3600 });
}

async function startServer(db, opts = {}) {
  const server = createServer();
  const wss = attachWebSocket(server, db, JWT_SECRET, {
    authTimeoutMs: 100,
    orchestratorOptions: { retryOptions: { maxRetries: 3, baseDelayMs: 1 } },
    ...opts,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, wss };
}

async function teardown(server, wss, sockets = []) {
  wss._notifyGameDeleted?.();

  // Terminate all client-side sockets and wait for close events
  const clientClosePromises = sockets.map(
    (ws) =>
      new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once("close", resolve);
        ws.terminate();
      })
  );
  await Promise.all(clientClosePromises);

  // Close the WebSocketServer (cleans up internal state and remaining clients)
  await new Promise((resolve) => wss.close(resolve));

  // Destroy all remaining TCP connections and close the server
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));

  // Node.js retains closed Server/Socket handles in the active handles list
  // even after close()/destroy().  Unref our server so it cannot block exit.
  server.unref();
  // Destroy any lingering half-open client TCP sockets
  for (const ws of sockets) {
    if (ws._socket && !ws._socket.destroyed) ws._socket.destroy();
  }
}

function connectWs(server) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    openSockets.push(ws);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitForMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try { resolve(JSON.parse(data.toString())); }
      catch (e) { reject(e); }
    });
    ws.once("error", reject);
  });
}

function collectMessages(ws, count, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const msgs = [];
    const timer = setTimeout(() => resolve(msgs), timeoutMs);
    ws.on("message", (data) => {
      try {
        msgs.push(JSON.parse(data.toString()));
        if (msgs.length >= count) {
          clearTimeout(timer);
          resolve(msgs);
        }
      } catch (e) { reject(e); }
    });
  });
}

async function authenticate(ws, sub, role) {
  const msgPromise = waitForMessage(ws);
  ws.send(JSON.stringify({ type: "auth", token: makeToken(sub, role) }));
  const msg = await msgPromise;
  expect(msg.type).toBe("auth_success");
  return msg;
}

function spyOnLogger() {
  const spies = {
    info: jest.spyOn(logger, "info").mockImplementation(() => {}),
    warn: jest.spyOn(logger, "warn").mockImplementation(() => {}),
    error: jest.spyOn(logger, "error").mockImplementation(() => {}),
  };
  const captured = {
    get log() { return spies.info.mock.calls.map((c) => c[0]); },
    get warn() { return spies.warn.mock.calls.map((c) => c[0]); },
    get error() { return spies.error.mock.calls.map((c) => c[0]); },
  };
  const restore = () => {
    spies.info.mockRestore();
    spies.warn.mockRestore();
    spies.error.mockRestore();
  };
  return { captured, restore };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let db, server, wss;
let captured, restore;
/** @type {WebSocket[]} */
let openSockets;

beforeEach(async () => {
  db = createTestDb();
  openSockets = [];
  ({ captured, restore } = spyOnLogger());
  ({ server, wss } = await startServer(db));
});

afterEach(async () => {
  await teardown(server, wss, openSockets);
  db.close();
  restore();
});

// ---------------------------------------------------------------------------
// CA-42 — Invalid JSON after authentication → ignored, WARN
// ---------------------------------------------------------------------------
describe("CA-42 — invalid JSON after auth", () => {
  it("should ignore invalid JSON silently and stay connected", async () => {
    const ws = await connectWs(server);
    await authenticate(ws, "admin-1", "admin");

    ws.send("not valid json!!!");
    await new Promise((r) => setTimeout(r, 30));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    const warns = captured.warn;
    expect(warns.some((w) => w.event === "GAME_MESSAGE_IGNORED")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CA-41 — Unknown message type after authentication → ignored, WARN
// ---------------------------------------------------------------------------
describe("CA-41 — unknown message type after auth", () => {
  it("should ignore unknown type from admin and stay connected", async () => {
    const ws = await connectWs(server);
    await authenticate(ws, "admin-1", "admin");

    ws.send(JSON.stringify({ type: "unknown_event" }));
    await new Promise((r) => setTimeout(r, 30));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    const warns = captured.warn;
    expect(warns.some((w) => w.event === "GAME_MESSAGE_IGNORED")).toBe(true);
  });

  it("should ignore unknown type from buzzer and stay connected", async () => {
    const ws = await connectWs(server);
    await authenticate(ws, "buzzer-1", "buzzer");

    ws.send(JSON.stringify({ type: "unknown_event" }));
    await new Promise((r) => setTimeout(r, 30));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    const warns = captured.warn;
    expect(warns.some((w) => w.event === "GAME_MESSAGE_IGNORED")).toBe(true);
  });

  it("should ignore message with missing type field", async () => {
    const ws = await connectWs(server);
    await authenticate(ws, "admin-1", "admin");

    ws.send(JSON.stringify({ data: "something" }));
    await new Promise((r) => setTimeout(r, 30));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    const warns = captured.warn;
    expect(warns.some((w) => w.event === "GAME_MESSAGE_IGNORED")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CA-38 — Buzzer sending admin-only message → ignored, WARN
// ---------------------------------------------------------------------------
describe("CA-38 — buzzer sending admin-only message", () => {
  it("should ignore trigger_title from buzzer", async () => {
    const ws = await connectWs(server);
    await authenticate(ws, "buzzer-1", "buzzer");

    ws.send(JSON.stringify({ type: "trigger_title" }));
    await new Promise((r) => setTimeout(r, 30));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    const warns = captured.warn;
    expect(warns.some((w) => w.event === "GAME_MESSAGE_IGNORED")).toBe(true);
  });

  it("should ignore trigger_choices from buzzer", async () => {
    const ws = await connectWs(server);
    await authenticate(ws, "buzzer-1", "buzzer");

    ws.send(JSON.stringify({ type: "trigger_choices" }));
    await new Promise((r) => setTimeout(r, 30));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    const warns = captured.warn;
    expect(warns.some((w) => w.event === "GAME_MESSAGE_IGNORED")).toBe(true);
  });

  it("should ignore trigger_correction from buzzer", async () => {
    const ws = await connectWs(server);
    await authenticate(ws, "buzzer-1", "buzzer");

    ws.send(JSON.stringify({ type: "trigger_correction" }));
    await new Promise((r) => setTimeout(r, 30));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    const warns = captured.warn;
    expect(warns.some((w) => w.event === "GAME_MESSAGE_IGNORED")).toBe(true);
  });

  it("should ignore trigger_next_question from buzzer", async () => {
    const ws = await connectWs(server);
    await authenticate(ws, "buzzer-1", "buzzer");

    ws.send(JSON.stringify({ type: "trigger_next_question" }));
    await new Promise((r) => setTimeout(r, 30));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    const warns = captured.warn;
    expect(warns.some((w) => w.event === "GAME_MESSAGE_IGNORED")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CA-39 — Admin sending buzzer-only message → ignored, WARN
// ---------------------------------------------------------------------------
describe("CA-39 — admin sending buzzer-only message", () => {
  it("should ignore 'answer' from admin", async () => {
    const ws = await connectWs(server);
    await authenticate(ws, "admin-1", "admin");

    ws.send(JSON.stringify({ type: "answer", value: "A" }));
    await new Promise((r) => setTimeout(r, 30));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    const warns = captured.warn;
    expect(warns.some((w) => w.event === "GAME_MESSAGE_IGNORED")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CA-43 — answer with missing/invalid fields → error INVALID_MESSAGE
// ---------------------------------------------------------------------------
describe("CA-43 — answer with missing fields", () => {
  it("should return INVALID_MESSAGE when 'value' is missing", async () => {
    const ws = await connectWs(server);
    await authenticate(ws, "buzzer-1", "buzzer");

    const msgPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "answer" }));
    const msg = await msgPromise;

    expect(msg.type).toBe("error");
    expect(msg.code).toBe("INVALID_MESSAGE");
  });

  it("should return INVALID_MESSAGE when 'value' is not a string (number)", async () => {
    const ws = await connectWs(server);
    await authenticate(ws, "buzzer-1", "buzzer");

    const msgPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "answer", value: 42 }));
    const msg = await msgPromise;

    expect(msg.type).toBe("error");
    expect(msg.code).toBe("INVALID_MESSAGE");
  });

  it("should return INVALID_MESSAGE when 'value' is null", async () => {
    const ws = await connectWs(server);
    await authenticate(ws, "buzzer-1", "buzzer");

    const msgPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "answer", value: null }));
    const msg = await msgPromise;

    expect(msg.type).toBe("error");
    expect(msg.code).toBe("INVALID_MESSAGE");
  });
});

// ---------------------------------------------------------------------------
// CA-4 / CA-6 / CA-7 / CA-8 — trigger_title: valid and error cases
// ---------------------------------------------------------------------------
describe("trigger_title", () => {
  it("CA-4: admin trigger_title broadcasts question_title to all connected clients", async () => {
    const adminWs = await connectWs(server);
    const buzzerWs = await connectWs(server);

    await authenticate(adminWs, "admin-1", "admin");
    const buzzerConnectedPromise = waitForMessage(adminWs);
    await authenticate(buzzerWs, "buzzer-1", "buzzer");
    const buzzerConnectedMsg = await buzzerConnectedPromise;
    expect(buzzerConnectedMsg.type).toBe("buzzer_connected");

    const adminMsgPromise = waitForMessage(adminWs);
    const buzzerMsgPromise = waitForMessage(buzzerWs);

    adminWs.send(JSON.stringify({ type: "trigger_title" }));

    const adminMsg = await adminMsgPromise;
    const buzzerMsg = await buzzerMsgPromise;

    expect(adminMsg.type).toBe("question_title");
    expect(buzzerMsg.type).toBe("question_title");
    expect(adminMsg.question_index).toBe(0);
    expect(adminMsg.question_type).toBe("MCQ");
    expect(adminMsg.title).toBeDefined();
    expect(adminMsg.time_limit).toBe(5);
  });

  it("CA-6: trigger_title in PENDING state returns INVALID_STATE error to admin", async () => {
    db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'PENDING' WHERE GAM_ID = ?").run("gam-1");

    const adminWs = await connectWs(server);
    await authenticate(adminWs, "admin-1", "admin");

    const msgPromise = waitForMessage(adminWs);
    adminWs.send(JSON.stringify({ type: "trigger_title" }));
    const msg = await msgPromise;

    expect(msg.type).toBe("error");
    expect(msg.code).toBe("INVALID_STATE");
  });

  it("CA-7: trigger_title in wrong state (non-OPEN) returns INVALID_STATE error to admin", async () => {
    db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");

    const adminWs = await connectWs(server);
    await authenticate(adminWs, "admin-1", "admin");

    const msgPromise = waitForMessage(adminWs);
    adminWs.send(JSON.stringify({ type: "trigger_title" }));
    const msg = await msgPromise;

    expect(msg.type).toBe("error");
    expect(msg.code).toBe("INVALID_STATE");
  });

  it("CA-8: trigger_title with no more questions returns NO_MORE_QUESTIONS", async () => {
    db.prepare("UPDATE T_GAME_GAM SET GAM_CURRENT_QUESTION_INDEX = 99 WHERE GAM_ID = ?").run("gam-1");

    const adminWs = await connectWs(server);
    await authenticate(adminWs, "admin-1", "admin");

    const msgPromise = waitForMessage(adminWs);
    adminWs.send(JSON.stringify({ type: "trigger_title" }));
    const msg = await msgPromise;

    expect(msg.type).toBe("error");
    expect(msg.code).toBe("NO_MORE_QUESTIONS");
  });
});

// ---------------------------------------------------------------------------
// CA-9 / CA-10 / CA-11 / CA-12 / CA-13 — trigger_choices
// ---------------------------------------------------------------------------
describe("trigger_choices", () => {
  beforeEach(() => {
    db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");
  });

  it("CA-9: admin trigger_choices broadcasts question_choices to all connected clients", async () => {
    const adminWs = await connectWs(server);
    const buzzerWs = await connectWs(server);

    await authenticate(adminWs, "admin-1", "admin");
    const buzzerConnectedPromise = waitForMessage(adminWs);
    await authenticate(buzzerWs, "buzzer-1", "buzzer");
    const buzzerConnectedMsg = await buzzerConnectedPromise;
    expect(buzzerConnectedMsg.type).toBe("buzzer_connected");

    const adminMsgPromise = waitForMessage(adminWs);
    const buzzerMsgPromise = waitForMessage(buzzerWs);

    adminWs.send(JSON.stringify({ type: "trigger_choices" }));

    const adminMsg = await adminMsgPromise;
    const buzzerMsg = await buzzerMsgPromise;

    expect(adminMsg.type).toBe("question_choices");
    expect(buzzerMsg.type).toBe("question_choices");
    expect(adminMsg.choices).toEqual(["Paris", "Lyon", "Marseille", "Toulouse"]);
    expect(adminMsg.started_at).toBeDefined();
    expect(adminMsg.time_limit).toBe(5);
  });

  it("CA-13: trigger_choices in wrong state returns INVALID_STATE", async () => {
    db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'OPEN' WHERE GAM_ID = ?").run("gam-1");

    const adminWs = await connectWs(server);
    await authenticate(adminWs, "admin-1", "admin");

    const msgPromise = waitForMessage(adminWs);
    adminWs.send(JSON.stringify({ type: "trigger_choices" }));
    const msg = await msgPromise;

    expect(msg.type).toBe("error");
    expect(msg.code).toBe("INVALID_STATE");
  });
});

// ---------------------------------------------------------------------------
// CA-15 / CA-16 / CA-17 / CA-18 — answer handling
// ---------------------------------------------------------------------------
describe("answer handling", () => {
  beforeEach(() => {
    db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_OPEN' WHERE GAM_ID = ?").run("gam-1");
  });

  it("CA-15: buzzer receives answer_received after sending valid answer", async () => {
    const adminWs = await connectWs(server);
    const buzzerWs = await connectWs(server);

    await authenticate(adminWs, "admin-1", "admin");
    await authenticate(buzzerWs, "buzzer-1", "buzzer");

    // Trigger choices to create the answer processor
    db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");
    const adminMsg1 = waitForMessage(adminWs);
    const buzzerMsg1 = waitForMessage(buzzerWs);
    adminWs.send(JSON.stringify({ type: "trigger_choices" }));
    await adminMsg1;
    await buzzerMsg1;

    // Send answer from buzzer
    const buzzerResponsePromise = waitForMessage(buzzerWs);
    buzzerWs.send(JSON.stringify({ type: "answer", value: "A" }));
    const response = await buzzerResponsePromise;

    expect(response.type).toBe("answer_received");
  });

  it("CA-16: admin receives player_answered when buzzer answers", async () => {
    const adminWs = await connectWs(server);
    const buzzerWs = await connectWs(server);

    await authenticate(adminWs, "admin-1", "admin");
    await authenticate(buzzerWs, "buzzer-1", "buzzer");

    // Trigger choices
    db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");
    const adminMsg1 = waitForMessage(adminWs);
    const buzzerMsg1 = waitForMessage(buzzerWs);
    adminWs.send(JSON.stringify({ type: "trigger_choices" }));
    await adminMsg1;
    await buzzerMsg1;

    // Collect next message from admin
    const adminResponsePromise = waitForMessage(adminWs);
    buzzerWs.send(JSON.stringify({ type: "answer", value: "B" }));
    const adminNotif = await adminResponsePromise;

    expect(adminNotif.type).toBe("player_answered");
    expect(adminNotif.participant_name).toBe("Alice");
    expect(adminNotif.answer).toBe("B");
    expect(typeof adminNotif.time_ms).toBe("number");
  });

  it("CA-18: answer in wrong game state is ignored", async () => {
    // Game is QUESTION_OPEN but no processor (no trigger_choices was called)
    const buzzerWs = await connectWs(server);
    await authenticate(buzzerWs, "buzzer-1", "buzzer");

    buzzerWs.send(JSON.stringify({ type: "answer", value: "A" }));
    await new Promise((r) => setTimeout(r, 30));

    // Connection still open, ignored silently
    expect(buzzerWs.readyState).toBe(WebSocket.OPEN);
    const warns = captured.warn;
    expect(warns.some((w) => w.event === "GAME_ANSWER_IGNORED")).toBe(true);
  });

  it("CA-22: answer from buzzer with no matching participant is ignored", async () => {
    // Add a buzzer user NOT in the game participants
    db.prepare(
      `INSERT INTO T_USER_USR (USR_ID, USR_USERNAME, USR_PASSWORD, USR_ROLE, USR_CREATED_AT)
       VALUES (?, ?, ?, ?, ?)`
    ).run("buzzer-stranger", "Stranger", "hashed", "buzzer", "2026-03-17T10:00:00.000Z");

    db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");

    const adminWs = await connectWs(server);
    const strangerWs = await connectWs(server);
    await authenticate(adminWs, "admin-1", "admin");
    await authenticate(strangerWs, "buzzer-stranger", "buzzer");

    // Start question open
    const a1 = waitForMessage(adminWs);
    const s1 = waitForMessage(strangerWs);
    adminWs.send(JSON.stringify({ type: "trigger_choices" }));
    await a1;
    await s1;

    strangerWs.send(JSON.stringify({ type: "answer", value: "A" }));
    await new Promise((r) => setTimeout(r, 30));

    const warns = captured.warn;
    expect(warns.some((w) => w.event === "GAME_ANSWER_IGNORED")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Buzzer order mapping — quiz_buzzer_XX maps to participant order XX
// ---------------------------------------------------------------------------
describe("buzzer order mapping — quiz_buzzer_XX usernames", () => {
  it("quiz_buzzer_01 answer is accepted as participant order 1 even with different display name", async () => {
    // Replace buzzer users with production-style quiz_buzzer_XX usernames
    db.prepare("DELETE FROM T_USER_USR WHERE USR_ROLE = 'buzzer'").run();
    for (const [i, name] of [[1, "quiz_buzzer_01"], [2, "quiz_buzzer_02"], [3, "quiz_buzzer_03"]]) {
      db.prepare(
        `INSERT INTO T_USER_USR (USR_ID, USR_USERNAME, USR_PASSWORD, USR_ROLE, USR_CREATED_AT)
         VALUES (?, ?, ?, ?, ?)`
      ).run(`buzzer-${i}`, name, "hashed", "buzzer", "2026-03-17T10:00:00.000Z");
    }

    db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");

    const adminWs = await connectWs(server);
    const buzzerWs = await connectWs(server);
    await authenticate(adminWs, "admin-1", "admin");
    await authenticate(buzzerWs, "buzzer-1", "buzzer");

    // Trigger choices to create the answer processor
    const a1 = waitForMessage(adminWs);
    const b1 = waitForMessage(buzzerWs);
    adminWs.send(JSON.stringify({ type: "trigger_choices" }));
    await a1;
    await b1;

    // Send answer from quiz_buzzer_01 → should map to participant order 1 (Alice)
    const buzzerResponsePromise = waitForMessage(buzzerWs);
    buzzerWs.send(JSON.stringify({ type: "answer", value: "A" }));
    const response = await buzzerResponsePromise;

    expect(response.type).toBe("answer_received");
  });

  it("full correction flow with quiz_buzzer_XX usernames sends results to correct buzzers", async () => {
    // Replace buzzer users with production-style quiz_buzzer_XX usernames
    db.prepare("DELETE FROM T_USER_USR WHERE USR_ROLE = 'buzzer'").run();
    for (const [i, name] of [[1, "quiz_buzzer_01"], [2, "quiz_buzzer_02"], [3, "quiz_buzzer_03"]]) {
      db.prepare(
        `INSERT INTO T_USER_USR (USR_ID, USR_USERNAME, USR_PASSWORD, USR_ROLE, USR_CREATED_AT)
         VALUES (?, ?, ?, ?, ?)`
      ).run(`buzzer-${i}`, name, "hashed", "buzzer", "2026-03-17T10:00:00.000Z");
    }

    db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");

    const adminWs = await connectWs(server);
    const buzzer1Ws = await connectWs(server);
    const buzzer2Ws = await connectWs(server);
    const buzzer3Ws = await connectWs(server);

    await authenticate(adminWs, "admin-1", "admin");
    await authenticate(buzzer1Ws, "buzzer-1", "buzzer");
    await authenticate(buzzer2Ws, "buzzer-2", "buzzer");
    await authenticate(buzzer3Ws, "buzzer-3", "buzzer");

    // trigger_choices
    const msgs1 = Promise.all([
      waitForMessage(adminWs),
      waitForMessage(buzzer1Ws),
      waitForMessage(buzzer2Ws),
      waitForMessage(buzzer3Ws),
    ]);
    adminWs.send(JSON.stringify({ type: "trigger_choices" }));
    await msgs1;

    // All 3 buzzers answer
    const b1Ack = waitForMessage(buzzer1Ws);
    buzzer1Ws.send(JSON.stringify({ type: "answer", value: "A" })); // correct (Paris)
    await b1Ack;

    const b2Ack = waitForMessage(buzzer2Ws);
    buzzer2Ws.send(JSON.stringify({ type: "answer", value: "B" })); // wrong
    await b2Ack;

    const b3Ack = waitForMessage(buzzer3Ws);
    buzzer3Ws.send(JSON.stringify({ type: "answer", value: "A" })); // correct
    await b3Ack;

    // admin receives all_answered
    await waitForMessage(adminWs);

    // trigger_correction
    adminWs.send(JSON.stringify({ type: "trigger_correction" }));

    const buzzer1Result = await waitForMessage(buzzer1Ws);
    const buzzer2Result = await waitForMessage(buzzer2Ws);
    const buzzer3Result = await waitForMessage(buzzer3Ws);
    const adminSummary = await waitForMessage(adminWs);

    expect(buzzer1Result.type).toBe("question_result");
    expect(buzzer1Result.correct).toBe(true);
    expect(buzzer1Result.points_earned).toBe(10);

    expect(buzzer2Result.type).toBe("question_result");
    expect(buzzer2Result.correct).toBe(false);

    expect(buzzer3Result.type).toBe("question_result");
    expect(buzzer3Result.correct).toBe(true);

    expect(adminSummary.type).toBe("question_result_summary");
    expect(adminSummary.results).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// CA-28 / CA-29 — trigger_correction error cases
// ---------------------------------------------------------------------------
describe("trigger_correction", () => {
  it("CA-28: trigger_correction in wrong state returns INVALID_STATE", async () => {
    const adminWs = await connectWs(server);
    await authenticate(adminWs, "admin-1", "admin");

    const msgPromise = waitForMessage(adminWs);
    adminWs.send(JSON.stringify({ type: "trigger_correction" }));
    const msg = await msgPromise;

    expect(msg.type).toBe("error");
    expect(msg.code).toBe("INVALID_STATE");
  });

  it("CA-29: trigger_correction while timer running and not all answered returns ANSWERS_PENDING", async () => {
    db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");

    const adminWs = await connectWs(server);
    const buzzerWs = await connectWs(server);
    await authenticate(adminWs, "admin-1", "admin");
    await authenticate(buzzerWs, "buzzer-1", "buzzer");

    // Start choices (timer is running)
    const a1 = waitForMessage(adminWs);
    const b1 = waitForMessage(buzzerWs);
    adminWs.send(JSON.stringify({ type: "trigger_choices" }));
    await a1;
    await b1;

    // Only 1 out of 3 answers
    const a2 = waitForMessage(adminWs);
    const b2 = waitForMessage(buzzerWs);
    buzzerWs.send(JSON.stringify({ type: "answer", value: "A" }));
    await b2;
    await a2; // consume the player_answered message sent to admin

    const msgPromise = waitForMessage(adminWs);
    adminWs.send(JSON.stringify({ type: "trigger_correction" }));
    const msg = await msgPromise;

    expect(msg.type).toBe("error");
    expect(msg.code).toBe("ANSWERS_PENDING");
  });
});

// ---------------------------------------------------------------------------
// CA-32 — trigger_next_question error case
// ---------------------------------------------------------------------------
describe("trigger_next_question", () => {
  it("CA-32: trigger_next_question in wrong state returns INVALID_STATE", async () => {
    const adminWs = await connectWs(server);
    await authenticate(adminWs, "admin-1", "admin");

    const msgPromise = waitForMessage(adminWs);
    adminWs.send(JSON.stringify({ type: "trigger_next_question" }));
    const msg = await msgPromise;

    expect(msg.type).toBe("error");
    expect(msg.code).toBe("INVALID_STATE");
  });

  it("CA-30: trigger_next_question increments question index and returns to OPEN", async () => {
    db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_CLOSED' WHERE GAM_ID = ?").run("gam-1");

    const adminWs = await connectWs(server);
    await authenticate(adminWs, "admin-1", "admin");

    adminWs.send(JSON.stringify({ type: "trigger_next_question" }));
    await new Promise((r) => setTimeout(r, 30));

    const row = db.prepare("SELECT GAM_STATUS, GAM_CURRENT_QUESTION_INDEX FROM T_GAME_GAM WHERE GAM_ID = ?").get("gam-1");
    expect(row.GAM_STATUS).toBe("OPEN");
    expect(row.GAM_CURRENT_QUESTION_INDEX).toBe(1);
  });

  it("CA-31: trigger_next_question on last question transitions to COMPLETED", async () => {
    db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_CLOSED', GAM_CURRENT_QUESTION_INDEX = 2 WHERE GAM_ID = ?").run("gam-1");

    const adminWs = await connectWs(server);
    await authenticate(adminWs, "admin-1", "admin");

    adminWs.send(JSON.stringify({ type: "trigger_next_question" }));
    await new Promise((r) => setTimeout(r, 30));

    const row = db.prepare("SELECT GAM_STATUS FROM T_GAME_GAM WHERE GAM_ID = ?").get("gam-1");
    expect(row.GAM_STATUS).toBe("COMPLETED");
  });
});

// ---------------------------------------------------------------------------
// CA-25 / CA-26 — Full correction flow: results sent to buzzers and admin
// ---------------------------------------------------------------------------
describe("trigger_correction — full result flow", () => {
  it("CA-25 + CA-26: sends question_result to each buzzer and question_result_summary to admin", async () => {
    db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");

    const adminWs = await connectWs(server);
    const buzzer1Ws = await connectWs(server);
    const buzzer2Ws = await connectWs(server);
    const buzzer3Ws = await connectWs(server);

    await authenticate(adminWs, "admin-1", "admin");
    await authenticate(buzzer1Ws, "buzzer-1", "buzzer");
    await authenticate(buzzer2Ws, "buzzer-2", "buzzer");
    await authenticate(buzzer3Ws, "buzzer-3", "buzzer");

    // trigger_choices → collect from all 4
    const msgs1 = Promise.all([
      waitForMessage(adminWs),
      waitForMessage(buzzer1Ws),
      waitForMessage(buzzer2Ws),
      waitForMessage(buzzer3Ws),
    ]);
    adminWs.send(JSON.stringify({ type: "trigger_choices" }));
    await msgs1;

    // All 3 buzzers answer
    const b1Ack = waitForMessage(buzzer1Ws);
    buzzer1Ws.send(JSON.stringify({ type: "answer", value: "A" })); // correct
    await b1Ack;

    const b2Ack = waitForMessage(buzzer2Ws);
    buzzer2Ws.send(JSON.stringify({ type: "answer", value: "B" })); // wrong
    await b2Ack;

    const b3Ack = waitForMessage(buzzer3Ws);
    buzzer3Ws.send(JSON.stringify({ type: "answer", value: "A" })); // correct
    await b3Ack;

    // admin receives all_answered
    await waitForMessage(adminWs); // all_answered

    // trigger_correction
    adminWs.send(JSON.stringify({ type: "trigger_correction" }));

    // Collect results: 3 buzzers get question_result, admin gets question_result_summary
    const buzzer1Result = await waitForMessage(buzzer1Ws);
    const buzzer2Result = await waitForMessage(buzzer2Ws);
    const buzzer3Result = await waitForMessage(buzzer3Ws);
    const adminSummary = await waitForMessage(adminWs);

    expect(buzzer1Result.type).toBe("question_result");
    expect(buzzer1Result.correct_answer).toBe("A");
    expect(buzzer1Result.player_answer).toBe("A");
    expect(buzzer1Result.correct).toBe(true);
    expect(buzzer1Result.points_earned).toBe(10);

    expect(buzzer2Result.type).toBe("question_result");
    expect(buzzer2Result.correct).toBe(false);
    expect(buzzer2Result.points_earned).toBe(0);

    expect(buzzer3Result.type).toBe("question_result");
    expect(buzzer3Result.correct).toBe(true);

    expect(adminSummary.type).toBe("question_result_summary");
    expect(adminSummary.results).toHaveLength(3);
    expect(adminSummary.ranking).toHaveLength(3);
    expect(adminSummary.correct_answer).toBe("A");
  });
});

// ---------------------------------------------------------------------------
// CA-11 — Timer expiration broadcasts timer_end
// ---------------------------------------------------------------------------
describe("CA-11 — timer expiration", () => {
  it("broadcasts timer_end when the timer expires", async () => {
    db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");

    const adminWs = await connectWs(server);
    await authenticate(adminWs, "admin-1", "admin");

    const choicesMsg = waitForMessage(adminWs);
    adminWs.send(JSON.stringify({ type: "trigger_choices" }));
    await choicesMsg;

    // Wait for timer_end (time_limit = 5s in test DB)
    const timerEnd = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timer_end not received")), 8000);
      adminWs.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "timer_end") {
          clearTimeout(t);
          resolve(msg);
        }
      });
    });

    expect(timerEnd.type).toBe("timer_end");
  }, 10000);
});

// ---------------------------------------------------------------------------
// CA-37 — Crash recovery: game in QUESTION_OPEN reset to OPEN on server start
// ---------------------------------------------------------------------------
describe("CA-37 — crash recovery (US-019 — recoverInterruptedGame before server start)", () => {
  it("should recover a game stuck in QUESTION_OPEN on server startup", async () => {
    db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_OPEN', GAM_CURRENT_QUESTION_INDEX = 1 WHERE GAM_ID = ?").run("gam-1");

    // US-019 CA-8: recovery runs before HTTP/WebSocket accepts connections
    recoverInterruptedGame(db);

    const newServer = createServer();
    const newWss = attachWebSocket(newServer, db, JWT_SECRET, { authTimeoutMs: 100 });
    await new Promise((r) => newServer.listen(0, "127.0.0.1", r));

    const row = db.prepare("SELECT GAM_STATUS, GAM_CURRENT_QUESTION_INDEX FROM T_GAME_GAM WHERE GAM_ID = ?").get("gam-1");
    expect(row.GAM_STATUS).toBe("OPEN");
    expect(row.GAM_CURRENT_QUESTION_INDEX).toBe(1);

    await teardown(newServer, newWss);
  });

  it("should recover a game stuck in QUESTION_TITLE on server startup", async () => {
    db.prepare("UPDATE T_GAME_GAM SET GAM_STATUS = 'QUESTION_TITLE' WHERE GAM_ID = ?").run("gam-1");

    // US-019 CA-8: recovery runs before HTTP/WebSocket accepts connections
    recoverInterruptedGame(db);

    const newServer = createServer();
    const newWss = attachWebSocket(newServer, db, JWT_SECRET, { authTimeoutMs: 100 });
    await new Promise((r) => newServer.listen(0, "127.0.0.1", r));

    const row = db.prepare("SELECT GAM_STATUS FROM T_GAME_GAM WHERE GAM_ID = ?").get("gam-1");
    expect(row.GAM_STATUS).toBe("OPEN");

    await teardown(newServer, newWss);
  });
});
