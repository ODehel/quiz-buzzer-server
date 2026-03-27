import { createServer } from "node:http";
import { WebSocket } from "ws";
import jwt from "jsonwebtoken";
import { openDatabase } from "../src/database/database.js";
import { attachWebSocket } from "../src/websocket/wsServer.js";
import { insertSound } from "../src/repositories/soundRepository.js";
import { insertUser } from "../src/repositories/userRepository.js";
import bcrypt from "bcrypt";

const JWT_SECRET = "a".repeat(32);
const SERVER_BASE_URL = "http://192.168.1.10:3000";

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
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), timeout);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

describe("WebSocket play_sound (US-017)", () => {
  let db;
  let httpServer;
  let wss;
  let port;

  beforeEach(async () => {
    db = openDatabase(":memory:");

    // Seed users
    const hashedPassword = await bcrypt.hash("password", 4);
    insertUser(db, { id: "admin-uuid", username: "admin", password: hashedPassword, role: "admin", createdAt: new Date().toISOString() });
    insertUser(db, { id: "buzzer-uuid-01", username: "quiz_buzzer_01", password: hashedPassword, role: "buzzer", createdAt: new Date().toISOString() });
    insertUser(db, { id: "buzzer-uuid-02", username: "quiz_buzzer_02", password: hashedPassword, role: "buzzer", createdAt: new Date().toISOString() });
    insertUser(db, { id: "buzzer-uuid-03", username: "quiz_buzzer_03", password: hashedPassword, role: "buzzer", createdAt: new Date().toISOString() });

    // Seed a sound
    insertSound(db, {
      id: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a",
      name: "Test Jingle",
      filename: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a.mp3",
      createdAt: new Date().toISOString(),
    });

    httpServer = createServer();
    wss = attachWebSocket(httpServer, db, JWT_SECRET, {
      authTimeoutMs: 5000,
      serverBaseUrl: SERVER_BASE_URL,
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

  // CA-22: play_sound with valid sound_id and specific targets
  test("CA-22 — sends play_sound_url to targeted buzzers", async () => {
    const adminWs = await connectAndAuth(port, adminToken());
    const buzzer1 = await connectAndAuth(port, buzzerToken("buzzer-uuid-01"));
    const buzzer2 = await connectAndAuth(port, buzzerToken("buzzer-uuid-02"));
    const buzzer3 = await connectAndAuth(port, buzzerToken("buzzer-uuid-03"));

    await wait(50);

    // Admin sends play_sound targeting buzzer 01 and 03
    adminWs.send(JSON.stringify({
      type: "play_sound",
      sound_id: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a",
      targets: ["quiz_buzzer_01", "quiz_buzzer_03"],
    }));

    const msg1 = await waitForMessage(buzzer1);
    const msg3 = await waitForMessage(buzzer3);
    const msg2 = await waitForMessage(buzzer2, 500);

    expect(msg1).toMatchObject({
      type: "play_sound_url",
      sound_id: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a",
      url: `${SERVER_BASE_URL}/uploads/sounds/018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a.mp3`,
    });
    expect(msg3).toMatchObject({ type: "play_sound_url" });
    expect(msg2).toBeNull(); // buzzer 2 not targeted

    adminWs.close();
    buzzer1.close();
    buzzer2.close();
    buzzer3.close();
  });

  // CA-23: empty or absent targets → broadcast
  test("CA-23 — empty targets broadcasts to all buzzers", async () => {
    const adminWs = await connectAndAuth(port, adminToken());
    const buzzer1 = await connectAndAuth(port, buzzerToken("buzzer-uuid-01"));
    const buzzer2 = await connectAndAuth(port, buzzerToken("buzzer-uuid-02"));

    await wait(50);

    adminWs.send(JSON.stringify({
      type: "play_sound",
      sound_id: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a",
      targets: [],
    }));

    const msg1 = await waitForMessage(buzzer1);
    const msg2 = await waitForMessage(buzzer2);

    expect(msg1).toMatchObject({ type: "play_sound_url" });
    expect(msg2).toMatchObject({ type: "play_sound_url" });

    adminWs.close();
    buzzer1.close();
    buzzer2.close();
  });

  test("CA-23 — absent targets broadcasts to all buzzers", async () => {
    const adminWs = await connectAndAuth(port, adminToken());
    const buzzer1 = await connectAndAuth(port, buzzerToken("buzzer-uuid-01"));

    await wait(50);

    adminWs.send(JSON.stringify({
      type: "play_sound",
      sound_id: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a",
    }));

    const msg1 = await waitForMessage(buzzer1);
    expect(msg1).toMatchObject({ type: "play_sound_url" });

    adminWs.close();
    buzzer1.close();
  });

  // CA-24: target not connected → ignored silently
  test("CA-24 — unknown target ignored silently", async () => {
    const adminWs = await connectAndAuth(port, adminToken());
    const buzzer1 = await connectAndAuth(port, buzzerToken("buzzer-uuid-01"));

    await wait(50);

    adminWs.send(JSON.stringify({
      type: "play_sound",
      sound_id: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a",
      targets: ["quiz_buzzer_01", "non_existent_buzzer"],
    }));

    const msg1 = await waitForMessage(buzzer1);
    expect(msg1).toMatchObject({ type: "play_sound_url" });

    adminWs.close();
    buzzer1.close();
  });

  // CA-25: sound_id not found → error to admin
  test("CA-25 — unknown sound_id → error SOUND_NOT_FOUND", async () => {
    const adminWs = await connectAndAuth(port, adminToken());

    await wait(50);

    adminWs.send(JSON.stringify({
      type: "play_sound",
      sound_id: "018e4f5a-0000-0000-0000-000000000000",
      targets: [],
    }));

    const msg = await waitForMessage(adminWs);
    expect(msg).toMatchObject({
      type: "error",
      code: "SOUND_NOT_FOUND",
      message: "The requested sound was not found.",
    });

    adminWs.close();
  });

  // CA-26: buzzer sends play_sound → ignored
  test("CA-26 — buzzer sending play_sound is ignored", async () => {
    const buzzer1 = await connectAndAuth(port, buzzerToken("buzzer-uuid-01"));

    await wait(50);

    buzzer1.send(JSON.stringify({
      type: "play_sound",
      sound_id: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a",
    }));

    const msg = await waitForMessage(buzzer1, 500);
    expect(msg).toBeNull(); // No response

    buzzer1.close();
  });

  // CA-28: missing sound_id → error INVALID_MESSAGE
  test("CA-28 — missing sound_id → error INVALID_MESSAGE", async () => {
    const adminWs = await connectAndAuth(port, adminToken());

    await wait(50);

    adminWs.send(JSON.stringify({
      type: "play_sound",
    }));

    const msg = await waitForMessage(adminWs);
    expect(msg).toMatchObject({
      type: "error",
      code: "INVALID_MESSAGE",
      message: "Missing or invalid field: sound_id.",
    });

    adminWs.close();
  });

  test("CA-28 — sound_id is not a string → error INVALID_MESSAGE", async () => {
    const adminWs = await connectAndAuth(port, adminToken());

    await wait(50);

    adminWs.send(JSON.stringify({
      type: "play_sound",
      sound_id: 12345,
    }));

    const msg = await waitForMessage(adminWs);
    expect(msg).toMatchObject({
      type: "error",
      code: "INVALID_MESSAGE",
    });

    adminWs.close();
  });

  // CA-29: buzzer receives play_sound_url with absolute URL
  test("CA-29 — play_sound_url contains absolute HTTP URL", async () => {
    const adminWs = await connectAndAuth(port, adminToken());
    const buzzer1 = await connectAndAuth(port, buzzerToken("buzzer-uuid-01"));

    await wait(50);

    adminWs.send(JSON.stringify({
      type: "play_sound",
      sound_id: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a",
      targets: ["quiz_buzzer_01"],
    }));

    const msg = await waitForMessage(buzzer1);
    expect(msg.url).toBe("http://192.168.1.10:3000/uploads/sounds/018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a.mp3");

    adminWs.close();
    buzzer1.close();
  });

  // CA-30: no buzzers connected during broadcast
  test("CA-30 — no buzzers connected → no error", async () => {
    const adminWs = await connectAndAuth(port, adminToken());

    await wait(50);

    adminWs.send(JSON.stringify({
      type: "play_sound",
      sound_id: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a",
      targets: [],
    }));

    // Admin should not receive any error
    const msg = await waitForMessage(adminWs, 500);
    expect(msg).toBeNull();

    adminWs.close();
  });
});
