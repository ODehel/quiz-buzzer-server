import { createServer } from "node:http";
import { WebSocket } from "ws";
import jwt from "jsonwebtoken";
import { openDatabase } from "../../src/database/database.ts";
import { attachWebSocket } from "../../src/websocket/wsServer.ts";
import { insertUser } from "../../src/repositories/userRepository.ts";
import bcrypt from "bcrypt";

const JWT_SECRET = "a".repeat(32);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectAndAuth(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", token }));
    });
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "auth_success") {
        resolve(ws);
      }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("Auth timeout")), 5000);
  });
}

function waitForMessage(ws, timeout = 2000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

function collectMessages(ws, count, timeout = 2000) {
  return new Promise((resolve) => {
    const messages = [];
    const timer = setTimeout(() => resolve(messages), timeout);
    const handler = (data) => {
      messages.push(JSON.parse(data.toString()));
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        resolve(messages);
      }
    };
    ws.on("message", handler);
  });
}

describe("WebSocket trigger_system_sound (US-018)", () => {
  let db;
  let httpServer;
  let wss;
  let port;

  beforeEach(async () => {
    db = openDatabase(":memory:");

    const hashedPassword = await bcrypt.hash("password", 4);
    insertUser(db, { id: "admin-uuid", username: "admin", password: hashedPassword, role: "admin", createdAt: new Date().toISOString() });
    insertUser(db, { id: "buzzer-uuid-01", username: "quiz_buzzer_01", password: hashedPassword, role: "buzzer", createdAt: new Date().toISOString() });
    insertUser(db, { id: "buzzer-uuid-02", username: "quiz_buzzer_02", password: hashedPassword, role: "buzzer", createdAt: new Date().toISOString() });
    insertUser(db, { id: "buzzer-uuid-03", username: "quiz_buzzer_03", password: hashedPassword, role: "buzzer", createdAt: new Date().toISOString() });

    httpServer = createServer();
    wss = attachWebSocket(httpServer, db, JWT_SECRET, {
      authTimeoutMs: 5000,
      orchestratorOptions: { disabled: true },
      heartbeatOptions: { disabled: true },
    });

    await new Promise((resolve) => {
      httpServer.listen(0, () => {
        port = httpServer.address().port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    wss.clients.forEach((ws) => ws.terminate());
    await new Promise((resolve) => httpServer.close(resolve));
    db.close();
  });

  function adminToken() {
    return jwt.sign({ sub: "admin-uuid", role: "admin" }, JWT_SECRET, { expiresIn: 3600 });
  }

  function buzzerToken(sub = "buzzer-uuid-01") {
    return jwt.sign({ sub, role: "buzzer" }, JWT_SECRET, { expiresIn: 3600 });
  }

  // ── CA-10: broadcast to all buzzers (no targets) ──────────────────────────

  test("CA-10 — trigger_system_sound with no targets broadcasts to all buzzers", async () => {
    const adminWs = await connectAndAuth(port, adminToken());
    const buzzer1 = await connectAndAuth(port, buzzerToken("buzzer-uuid-01"));
    const buzzer2 = await connectAndAuth(port, buzzerToken("buzzer-uuid-02"));

    await wait(50);

    adminWs.send(JSON.stringify({
      type: "trigger_system_sound",
      sound_id: "WAITING",
    }));

    const msg1 = await waitForMessage(buzzer1);
    const msg2 = await waitForMessage(buzzer2);

    expect(msg1).toMatchObject({ type: "play_system_sound", sound_id: "WAITING" });
    expect(msg2).toMatchObject({ type: "play_system_sound", sound_id: "WAITING" });

    // Admin should NOT receive play_system_sound
    const adminMsg = await waitForMessage(adminWs, 300);
    expect(adminMsg).toBeNull();

    adminWs.close();
    buzzer1.close();
    buzzer2.close();
  });

  test("CA-10 — trigger_system_sound with empty targets broadcasts to all buzzers", async () => {
    const adminWs = await connectAndAuth(port, adminToken());
    const buzzer1 = await connectAndAuth(port, buzzerToken("buzzer-uuid-01"));

    await wait(50);

    adminWs.send(JSON.stringify({
      type: "trigger_system_sound",
      sound_id: "SUSPENSE",
      targets: [],
    }));

    const msg1 = await waitForMessage(buzzer1);
    expect(msg1).toMatchObject({ type: "play_system_sound", sound_id: "SUSPENSE" });

    adminWs.close();
    buzzer1.close();
  });

  // ── CA-11: targeted delivery ──────────────────────────────────────────────

  test("CA-11 — trigger_system_sound with targets sends only to targeted buzzers", async () => {
    const adminWs = await connectAndAuth(port, adminToken());
    const buzzer1 = await connectAndAuth(port, buzzerToken("buzzer-uuid-01"));
    const buzzer2 = await connectAndAuth(port, buzzerToken("buzzer-uuid-02"));
    const buzzer3 = await connectAndAuth(port, buzzerToken("buzzer-uuid-03"));

    await wait(50);

    adminWs.send(JSON.stringify({
      type: "trigger_system_sound",
      sound_id: "WAITING",
      targets: ["quiz_buzzer_01", "quiz_buzzer_03"],
    }));

    const msg1 = await waitForMessage(buzzer1);
    const msg3 = await waitForMessage(buzzer3);
    const msg2 = await waitForMessage(buzzer2, 300);

    expect(msg1).toMatchObject({ type: "play_system_sound", sound_id: "WAITING" });
    expect(msg3).toMatchObject({ type: "play_system_sound", sound_id: "WAITING" });
    expect(msg2).toBeNull(); // buzzer 2 not targeted

    adminWs.close();
    buzzer1.close();
    buzzer2.close();
    buzzer3.close();
  });

  // ── CA-12: missing sound_id → INVALID_MESSAGE ─────────────────────────────

  test("CA-12 — missing sound_id → error INVALID_MESSAGE", async () => {
    const adminWs = await connectAndAuth(port, adminToken());
    await wait(50);

    adminWs.send(JSON.stringify({ type: "trigger_system_sound" }));

    const msg = await waitForMessage(adminWs);
    expect(msg).toMatchObject({
      type: "error",
      code: "INVALID_MESSAGE",
      message: "Missing or invalid field: sound_id.",
    });

    adminWs.close();
  });

  test("CA-12 — empty string sound_id → error INVALID_MESSAGE", async () => {
    const adminWs = await connectAndAuth(port, adminToken());
    await wait(50);

    adminWs.send(JSON.stringify({ type: "trigger_system_sound", sound_id: "" }));

    const msg = await waitForMessage(adminWs);
    expect(msg).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });

    adminWs.close();
  });

  test("CA-12 — non-string sound_id → error INVALID_MESSAGE", async () => {
    const adminWs = await connectAndAuth(port, adminToken());
    await wait(50);

    adminWs.send(JSON.stringify({ type: "trigger_system_sound", sound_id: 42 }));

    const msg = await waitForMessage(adminWs);
    expect(msg).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });

    adminWs.close();
  });

  // ── CA-13: unknown sound_id → UNKNOWN_SYSTEM_SOUND ────────────────────────

  test("CA-13 — unknown sound_id → error UNKNOWN_SYSTEM_SOUND", async () => {
    const adminWs = await connectAndAuth(port, adminToken());
    await wait(50);

    adminWs.send(JSON.stringify({
      type: "trigger_system_sound",
      sound_id: "NONEXISTENT_SOUND",
    }));

    const msg = await waitForMessage(adminWs);
    expect(msg).toMatchObject({
      type: "error",
      code: "UNKNOWN_SYSTEM_SOUND",
      message: "Unknown system sound identifier.",
    });

    adminWs.close();
  });

  // ── CA-14: target not connected → ignored silently ────────────────────────

  test("CA-14 — target not connected is ignored silently", async () => {
    const adminWs = await connectAndAuth(port, adminToken());
    const buzzer1 = await connectAndAuth(port, buzzerToken("buzzer-uuid-01"));

    await wait(50);

    adminWs.send(JSON.stringify({
      type: "trigger_system_sound",
      sound_id: "WAITING",
      targets: ["quiz_buzzer_01", "non_existent_buzzer"],
    }));

    const msg1 = await waitForMessage(buzzer1);
    expect(msg1).toMatchObject({ type: "play_system_sound", sound_id: "WAITING" });

    // Admin should NOT receive an error for the missing target
    const adminMsg = await waitForMessage(adminWs, 300);
    expect(adminMsg).toBeNull();

    adminWs.close();
    buzzer1.close();
  });

  // ── CA-15: buzzer sends trigger_system_sound → ignored ────────────────────

  test("CA-15 — buzzer sending trigger_system_sound is ignored", async () => {
    const buzzer1 = await connectAndAuth(port, buzzerToken("buzzer-uuid-01"));

    await wait(50);

    buzzer1.send(JSON.stringify({
      type: "trigger_system_sound",
      sound_id: "WAITING",
    }));

    const msg = await waitForMessage(buzzer1, 500);
    expect(msg).toBeNull();

    buzzer1.close();
  });

  // ── CA-16/CA-19: unauthenticated client → ignored ────────────────────────

  test("CA-16/CA-19 — unauthenticated client cannot send trigger_system_sound", async () => {
    // An unauthenticated client can't send game messages at all because
    // the auth flow closes the connection on invalid auth, and messages
    // before auth are treated as auth attempts.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    await new Promise((resolve) => ws.on("open", resolve));

    // Send trigger_system_sound without authenticating first
    ws.send(JSON.stringify({
      type: "trigger_system_sound",
      sound_id: "WAITING",
    }));

    // The server will treat this as an auth message and close with 4001
    await new Promise((resolve) => {
      ws.on("close", (code) => {
        expect(code).toBe(4001);
        resolve();
      });
    });
  });

  // ── CA-9: no buzzers connected during broadcast ───────────────────────────

  test("CA-9 — no buzzers connected: trigger_system_sound completes without error", async () => {
    const adminWs = await connectAndAuth(port, adminToken());
    await wait(50);

    adminWs.send(JSON.stringify({
      type: "trigger_system_sound",
      sound_id: "GAME_START",
    }));

    // Admin should not receive any error
    const msg = await waitForMessage(adminWs, 500);
    expect(msg).toBeNull();

    adminWs.close();
  });

  // ── CA-17: buzzer receives play_system_sound with known sound_id ──────────

  test("CA-17 — buzzer receives play_system_sound with known sound_id", async () => {
    const adminWs = await connectAndAuth(port, adminToken());
    const buzzer1 = await connectAndAuth(port, buzzerToken("buzzer-uuid-01"));

    await wait(50);

    adminWs.send(JSON.stringify({
      type: "trigger_system_sound",
      sound_id: "CORRECT_ANSWER",
    }));

    const msg = await waitForMessage(buzzer1);
    expect(msg).toEqual({ type: "play_system_sound", sound_id: "CORRECT_ANSWER" });

    adminWs.close();
    buzzer1.close();
  });

  // ── CA-7: game state change OPEN → GAME_START sound ───────────────────────

  test("CA-7 — _notifyGameStateChange('OPEN') broadcasts GAME_START", async () => {
    const buzzer1 = await connectAndAuth(port, buzzerToken("buzzer-uuid-01"));
    const buzzer2 = await connectAndAuth(port, buzzerToken("buzzer-uuid-02"));

    await wait(50);

    // Simulate game state change notification
    wss._notifyGameStateChange("OPEN");

    const msg1 = await waitForMessage(buzzer1);
    const msg2 = await waitForMessage(buzzer2);

    expect(msg1).toMatchObject({ type: "play_system_sound", sound_id: "GAME_START" });
    expect(msg2).toMatchObject({ type: "play_system_sound", sound_id: "GAME_START" });

    buzzer1.close();
    buzzer2.close();
  });

  // ── CA-8: game state change COMPLETED → GAME_END sound ────────────────────

  test("CA-8 — _notifyGameStateChange('COMPLETED') broadcasts GAME_END", async () => {
    const buzzer1 = await connectAndAuth(port, buzzerToken("buzzer-uuid-01"));

    await wait(50);

    wss._notifyGameStateChange("COMPLETED");

    const msg1 = await waitForMessage(buzzer1);
    expect(msg1).toMatchObject({ type: "play_system_sound", sound_id: "GAME_END" });

    buzzer1.close();
  });

  // ── CA-20: internal error handling ────────────────────────────────────────

  test("CA-20 — trigger_system_sound handles errors gracefully", async () => {
    // This is tested indirectly: the broadcastSystemSoundToBuzzers function
    // catches send errors, so even if a buzzer connection fails during send,
    // the server doesn't crash.
    const adminWs = await connectAndAuth(port, adminToken());
    await wait(50);

    // Valid trigger with all catalogue sounds should work
    for (const soundId of ["BUZZ_PRESSED", "BUZZ_LOCKED", "BUZZ_INVALIDATED",
      "CORRECT_ANSWER", "WRONG_ANSWER", "TIMER_END",
      "GAME_START", "GAME_END", "WAITING", "SUSPENSE"]) {
      adminWs.send(JSON.stringify({
        type: "trigger_system_sound",
        sound_id: soundId,
      }));
    }

    // No error should be received
    const msg = await waitForMessage(adminWs, 500);
    expect(msg).toBeNull();

    adminWs.close();
  });
});
