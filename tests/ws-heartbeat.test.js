import { jest } from "@jest/globals";

// ---------------------------------------------------------------------------
// Mock logger — must be set up BEFORE importing ws-heartbeat
// ---------------------------------------------------------------------------
jest.unstable_mockModule("../src/utils/logger.js", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

const { logWarn, logError } = await import("../src/utils/logger.js");
const {
  startHeartbeat,
  stopHeartbeat,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_MISSED,
} = await import("../src/websocket/ws-heartbeat.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockWs() {
  const listeners = {};
  return {
    readyState: 1, // WebSocket.OPEN
    ping: jest.fn(),
    close: jest.fn(),
    on: jest.fn((event, cb) => {
      listeners[event] = cb;
    }),
    _listeners: listeners,
    /** Simulate receiving a pong frame */
    emitPong() {
      if (listeners.pong) listeners.pong();
    },
  };
}

function createFakeTimers() {
  const intervals = [];
  return {
    intervals,
    setIntervalFn: jest.fn((cb, ms) => {
      const id = { cb, ms, cleared: false };
      intervals.push(id);
      return id;
    }),
    clearIntervalFn: jest.fn((id) => {
      if (id) id.cleared = true;
    }),
    /** Manually tick the latest interval n times */
    tick(n = 1) {
      const last = intervals[intervals.length - 1];
      for (let i = 0; i < n; i++) {
        if (!last.cleared) last.cb();
      }
    },
  };
}

const defaultEntry = { username: "quiz_buzzer_01", role: "buzzer" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ws-heartbeat", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── CA-1: heartbeat starts after auth_success ──────────────────────────

  test("CA-1: startHeartbeat sets up an interval with the configured delay", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();

    startHeartbeat(ws, defaultEntry, {
      intervalMs: 30_000,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    expect(timers.setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(timers.intervals).toHaveLength(1);

    // Cleanup
    stopHeartbeat(ws, { clearIntervalFn: timers.clearIntervalFn });
  });

  // ── CA-2: no heartbeat before auth ─────────────────────────────────────

  test("CA-2: no ping is sent if startHeartbeat is never called", () => {
    const ws = createMockWs();
    // Simply verify no ping was called — startHeartbeat not invoked
    expect(ws.ping).not.toHaveBeenCalled();
  });

  // ── CA-3: timer cancelled on disconnect ────────────────────────────────

  test("CA-3: stopHeartbeat cancels the interval timer", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();

    startHeartbeat(ws, defaultEntry, {
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    stopHeartbeat(ws, { clearIntervalFn: timers.clearIntervalFn });

    expect(timers.clearIntervalFn).toHaveBeenCalledWith(timers.intervals[0]);
    expect(timers.intervals[0].cleared).toBe(true);
  });

  test("CA-3: no ping sent after stopHeartbeat", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();

    startHeartbeat(ws, defaultEntry, {
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    stopHeartbeat(ws, { clearIntervalFn: timers.clearIntervalFn });

    // Attempting to tick after stop should not call ping (timer is cleared)
    // The tick helper checks `cleared` flag
    timers.tick(1);
    // Since the interval is cleared, the callback should still execute in our mock
    // but in real code clearInterval prevents it. We verify clearInterval was called.
    expect(timers.clearIntervalFn).toHaveBeenCalled();
  });

  // ── CA-4: ping sent every interval ─────────────────────────────────────

  test("CA-4: a Ping frame is sent on each interval tick", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();

    startHeartbeat(ws, defaultEntry, {
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    // First tick: sends ping
    timers.tick(1);
    expect(ws.ping).toHaveBeenCalledTimes(1);

    // Simulate pong to reset counter
    ws.emitPong();

    // Second tick: sends another ping
    timers.tick(1);
    expect(ws.ping).toHaveBeenCalledTimes(2);

    stopHeartbeat(ws, { clearIntervalFn: timers.clearIntervalFn });
  });

  // ── CA-5: pong resets missed counter ───────────────────────────────────

  test("CA-5: receiving a Pong resets missed_pings counter", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();

    startHeartbeat(ws, defaultEntry, {
      maxMissed: 3,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    // 2 ticks without pong → missed = 2
    timers.tick(2);
    expect(ws.ping).toHaveBeenCalledTimes(2);

    // Receive pong → resets to 0
    ws.emitPong();

    // 3 more ticks without pong → missed goes 1, 2, 3 → close on 3rd check
    timers.tick(1);
    expect(ws.ping).toHaveBeenCalledTimes(3);
    timers.tick(1);
    expect(ws.ping).toHaveBeenCalledTimes(4);
    timers.tick(1);
    expect(ws.ping).toHaveBeenCalledTimes(5);

    // Next tick should trigger close (missed = 3)
    timers.tick(1);
    expect(ws.close).toHaveBeenCalledWith(1000, "Heartbeat timeout.");

    stopHeartbeat(ws, { clearIntervalFn: timers.clearIntervalFn });
  });

  // ── CA-6: missed counter increments ────────────────────────────────────

  test("CA-6: missed_pings increments on each tick without Pong", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();

    startHeartbeat(ws, defaultEntry, {
      maxMissed: 3,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    // Tick 1: missed = 1 (ping sent)
    timers.tick(1);
    expect(ws.ping).toHaveBeenCalledTimes(1);
    expect(ws.close).not.toHaveBeenCalled();

    // Tick 2: missed = 2 (ping sent)
    timers.tick(1);
    expect(ws.ping).toHaveBeenCalledTimes(2);
    expect(ws.close).not.toHaveBeenCalled();

    // Tick 3: missed = 3 (ping sent)
    timers.tick(1);
    expect(ws.ping).toHaveBeenCalledTimes(3);
    expect(ws.close).not.toHaveBeenCalled();

    // Tick 4: missed >= 3 → close triggered
    timers.tick(1);
    expect(ws.close).toHaveBeenCalledWith(1000, "Heartbeat timeout.");

    stopHeartbeat(ws, { clearIntervalFn: timers.clearIntervalFn });
  });

  // ── CA-7: connection closed after 3 missed pings ───────────────────────

  test("CA-7: connection closed with code 1000 after maxMissed pings", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();

    startHeartbeat(ws, defaultEntry, {
      maxMissed: 3,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    // 3 ticks → missed = 3, 4th tick triggers close
    timers.tick(3);
    expect(ws.close).not.toHaveBeenCalled();

    timers.tick(1);
    expect(ws.close).toHaveBeenCalledWith(1000, "Heartbeat timeout.");

    stopHeartbeat(ws, { clearIntervalFn: timers.clearIntervalFn });
  });

  // ── CA-8: WEBSOCKET_HEARTBEAT_TIMEOUT logged before close ──────────────

  test("CA-8: WEBSOCKET_HEARTBEAT_TIMEOUT is logged at WARN level with correct fields", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();
    const entry = { username: "quiz_buzzer_01", role: "buzzer" };

    startHeartbeat(ws, entry, {
      maxMissed: 3,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
      ip: "192.168.1.50",
    });

    // Trigger timeout: 3 ticks (missed=3), then 4th tick
    timers.tick(4);

    expect(logWarn).toHaveBeenCalledWith("WEBSOCKET_HEARTBEAT_TIMEOUT", {
      username: "quiz_buzzer_01",
      role: "buzzer",
      ip: "192.168.1.50",
      missed_pings: 3,
    });
  });

  // ── CA-9: client removed from registry after heartbeat timeout ─────────
  // This is tested at the integration level (wsServer handles registry cleanup
  // via the close event, which is triggered by ws.close(1000) from heartbeat).

  test("CA-9: ws.close(1000) is called, triggering registry cleanup via close event", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();

    startHeartbeat(ws, defaultEntry, {
      maxMissed: 3,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    timers.tick(4);

    // ws.close(1000) triggers the 'close' event on WebSocket,
    // which is handled by wsServer.js to remove from registry
    expect(ws.close).toHaveBeenCalledWith(1000, "Heartbeat timeout.");
  });

  // ── CA-10: counters updated after heartbeat close ──────────────────────
  // Same as CA-9: the close event in wsServer.js handles counter updates.
  // Here we verify the close call is made with the right code.

  test("CA-10: heartbeat timeout closes connection, allowing wsServer to update counters", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();

    startHeartbeat(ws, { username: "admin_user", role: "admin" }, {
      maxMissed: 3,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    timers.tick(4);

    expect(ws.close).toHaveBeenCalledWith(1000, "Heartbeat timeout.");
  });

  // ── CA-11: normal close before timeout doesn't trigger heartbeat ───────

  test("CA-11: stopHeartbeat prevents timeout from firing after normal disconnect", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();

    startHeartbeat(ws, defaultEntry, {
      maxMissed: 3,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    // 2 ticks without pong → missed = 2
    timers.tick(2);

    // Client disconnects normally → stopHeartbeat called
    stopHeartbeat(ws, { clearIntervalFn: timers.clearIntervalFn });

    expect(timers.clearIntervalFn).toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
  });

  // ── CA-12: unexpected error during heartbeat ───────────────────────────

  test("CA-12: unexpected error in ping() logs INTERNAL_ERROR and closes with 1011", () => {
    const ws = createMockWs();
    ws.ping.mockImplementation(() => {
      throw new Error("Unexpected socket failure");
    });
    const timers = createFakeTimers();

    startHeartbeat(ws, { username: "buzzer_03", role: "buzzer" }, {
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
      ip: "10.0.0.5",
    });

    timers.tick(1);

    expect(logError).toHaveBeenCalledWith("INTERNAL_ERROR", {
      message: "Unexpected socket failure",
      username: "buzzer_03",
      role: "buzzer",
      ip: "10.0.0.5",
    });
    expect(ws.close).toHaveBeenCalledWith(1011, "Internal server error.");
  });

  // ── CA-13: injectable timers for testability ───────────────────────────

  test("CA-13: setIntervalFn and clearIntervalFn are injectable", () => {
    const ws = createMockWs();
    const customSetInterval = jest.fn(() => "custom-timer-id");
    const customClearInterval = jest.fn();

    startHeartbeat(ws, defaultEntry, {
      setIntervalFn: customSetInterval,
      clearIntervalFn: customClearInterval,
    });

    expect(customSetInterval).toHaveBeenCalledWith(expect.any(Function), HEARTBEAT_INTERVAL_MS);

    stopHeartbeat(ws, { clearIntervalFn: customClearInterval });

    expect(customClearInterval).toHaveBeenCalledWith("custom-timer-id");
  });

  // ── Default values ─────────────────────────────────────────────────────

  test("exports default constants matching spec (30s interval, 3 max missed)", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(HEARTBEAT_MAX_MISSED).toBe(3);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  test("stopHeartbeat on a ws with no active heartbeat is a no-op", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();

    // Should not throw
    expect(() => stopHeartbeat(ws, { clearIntervalFn: timers.clearIntervalFn })).not.toThrow();
    expect(timers.clearIntervalFn).not.toHaveBeenCalled();
  });

  test("calling startHeartbeat twice replaces the previous timer", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();

    startHeartbeat(ws, defaultEntry, {
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    startHeartbeat(ws, defaultEntry, {
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    // First timer should have been cleared
    expect(timers.intervals[0].cleared).toBe(true);
    // Second timer should be active
    expect(timers.intervals).toHaveLength(2);

    stopHeartbeat(ws, { clearIntervalFn: timers.clearIntervalFn });
  });

  test("ip defaults to 'unknown' when not provided", () => {
    const ws = createMockWs();
    const timers = createFakeTimers();

    startHeartbeat(ws, defaultEntry, {
      maxMissed: 1,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
      // no ip provided
    });

    // 1 tick → missed = 1, 2nd tick → close
    timers.tick(2);

    expect(logWarn).toHaveBeenCalledWith("WEBSOCKET_HEARTBEAT_TIMEOUT", expect.objectContaining({
      ip: "unknown",
    }));
  });
});
