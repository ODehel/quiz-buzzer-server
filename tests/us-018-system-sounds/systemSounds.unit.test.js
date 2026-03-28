import { SYSTEM_SOUNDS } from "../../src/constants/systemSounds.js";
import { sendSystemSound, broadcastSystemSoundToBuzzers } from "../../src/utils/soundUtils.js";
import { WebSocket } from "ws";

// ── SYSTEM_SOUNDS constant ──────────────────────────────────────────────────

describe("SYSTEM_SOUNDS constant", () => {
  test("contains exactly 10 system sound identifiers", () => {
    expect(SYSTEM_SOUNDS.size).toBe(10);
  });

  test.each([
    "BUZZ_PRESSED", "BUZZ_LOCKED", "BUZZ_INVALIDATED",
    "CORRECT_ANSWER", "WRONG_ANSWER", "TIMER_END",
    "GAME_START", "GAME_END", "WAITING", "SUSPENSE",
  ])("contains %s", (soundId) => {
    expect(SYSTEM_SOUNDS.has(soundId)).toBe(true);
  });

  test("does not contain unknown identifiers", () => {
    expect(SYSTEM_SOUNDS.has("UNKNOWN")).toBe(false);
    expect(SYSTEM_SOUNDS.has("")).toBe(false);
  });
});

// ── sendSystemSound ─────────────────────────────────────────────────────────

describe("sendSystemSound", () => {
  test("sends play_system_sound message to OPEN WebSocket", () => {
    const sent = [];
    const ws = {
      readyState: WebSocket.OPEN,
      send: (data) => sent.push(JSON.parse(data)),
    };

    sendSystemSound(ws, "BUZZ_PRESSED");

    expect(sent).toEqual([{ type: "play_system_sound", sound_id: "BUZZ_PRESSED" }]);
  });

  test("does not send if WebSocket is not OPEN", () => {
    const sent = [];
    const ws = {
      readyState: WebSocket.CLOSED,
      send: (data) => sent.push(data),
    };

    sendSystemSound(ws, "BUZZ_PRESSED");

    expect(sent).toEqual([]);
  });

  test("catches send errors without throwing (non-blocking)", () => {
    const ws = {
      readyState: WebSocket.OPEN,
      send: () => { throw new Error("Connection lost"); },
    };

    expect(() => sendSystemSound(ws, "BUZZ_PRESSED")).not.toThrow();
  });
});

// ── broadcastSystemSoundToBuzzers ───────────────────────────────────────────

describe("broadcastSystemSoundToBuzzers", () => {
  function createRegistry(entries) {
    const map = new Map();
    for (const [key, entry] of entries) {
      map.set(key, entry);
    }
    return map;
  }

  function mockWs(open = true) {
    const messages = [];
    return {
      readyState: open ? WebSocket.OPEN : WebSocket.CLOSED,
      send: (data) => messages.push(JSON.parse(data)),
      _messages: messages,
    };
  }

  test("sends play_system_sound to all connected buzzers", () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    const wsAdmin = mockWs();

    const registry = createRegistry([
      ["admin-1", { ws: wsAdmin, role: "admin", username: "admin" }],
      ["buzzer-1", { ws: ws1, role: "buzzer", username: "buzzer_01" }],
      ["buzzer-2", { ws: ws2, role: "buzzer", username: "buzzer_02" }],
    ]);

    broadcastSystemSoundToBuzzers(registry, "TIMER_END", "auto");

    expect(ws1._messages).toEqual([{ type: "play_system_sound", sound_id: "TIMER_END" }]);
    expect(ws2._messages).toEqual([{ type: "play_system_sound", sound_id: "TIMER_END" }]);
    expect(wsAdmin._messages).toEqual([]); // admin should NOT receive
  });

  test("CA-9 — no buzzers connected: logs SYSTEM_SOUND_NO_TARGETS without error", () => {
    const wsAdmin = mockWs();
    const registry = createRegistry([
      ["admin-1", { ws: wsAdmin, role: "admin", username: "admin" }],
    ]);

    expect(() => broadcastSystemSoundToBuzzers(registry, "GAME_START", "auto")).not.toThrow();
    expect(wsAdmin._messages).toEqual([]);
  });

  test("skips closed buzzer connections", () => {
    const ws1 = mockWs(true);
    const ws2 = mockWs(false); // closed

    const registry = createRegistry([
      ["buzzer-1", { ws: ws1, role: "buzzer", username: "buzzer_01" }],
      ["buzzer-2", { ws: ws2, role: "buzzer", username: "buzzer_02" }],
    ]);

    broadcastSystemSoundToBuzzers(registry, "GAME_END", "auto");

    expect(ws1._messages).toEqual([{ type: "play_system_sound", sound_id: "GAME_END" }]);
    expect(ws2._messages).toEqual([]);
  });

  test("catches send errors without throwing", () => {
    const ws1 = {
      readyState: WebSocket.OPEN,
      send: () => { throw new Error("Connection lost"); },
    };

    const registry = createRegistry([
      ["buzzer-1", { ws: ws1, role: "buzzer", username: "buzzer_01" }],
    ]);

    expect(() => broadcastSystemSoundToBuzzers(registry, "TIMER_END", "auto")).not.toThrow();
  });
});
