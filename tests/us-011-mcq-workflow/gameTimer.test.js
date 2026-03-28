import { jest } from "@jest/globals";
import {
    createGameTimer,
} from "../../src/game/gameTimer.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function flushTimers(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("gameTimer", () => {

    // ── createGameTimer — basic lifecycle ──────────────────────────────────────

    describe("createGameTimer — lifecycle", () => {
        it("returns a timer object with start, stop, and isRunning", () => {
            const timer = createGameTimer({ timeLimitSeconds: 30, onTick: () => { }, onExpire: () => { } });
            expect(timer).toHaveProperty("start");
            expect(timer).toHaveProperty("stop");
            expect(timer).toHaveProperty("isRunning");
            expect(typeof timer.start).toBe("function");
            expect(typeof timer.stop).toBe("function");
            expect(typeof timer.isRunning).toBe("function");
        });

        it("isRunning returns false before start", () => {
            const timer = createGameTimer({ timeLimitSeconds: 30, onTick: () => { }, onExpire: () => { } });
            expect(timer.isRunning()).toBe(false);
        });

        it("isRunning returns true after start", () => {
            const timer = createGameTimer({ timeLimitSeconds: 30, onTick: () => { }, onExpire: () => { } });
            timer.start();
            expect(timer.isRunning()).toBe(true);
            timer.stop();
        });

        it("isRunning returns false after stop", () => {
            const timer = createGameTimer({ timeLimitSeconds: 30, onTick: () => { }, onExpire: () => { } });
            timer.start();
            timer.stop();
            expect(timer.isRunning()).toBe(false);
        });

        it("stop is idempotent (no error if called twice)", () => {
            const timer = createGameTimer({ timeLimitSeconds: 30, onTick: () => { }, onExpire: () => { } });
            timer.start();
            timer.stop();
            expect(() => timer.stop()).not.toThrow();
        });

        it("stop is safe to call before start", () => {
            const timer = createGameTimer({ timeLimitSeconds: 30, onTick: () => { }, onExpire: () => { } });
            expect(() => timer.stop()).not.toThrow();
        });
    });

    // ── onTick callback (CA-10) ───────────────────────────────────────────────

    describe("onTick — CA-10", () => {
        beforeEach(() => { jest.useFakeTimers(); });
        afterEach(() => { jest.useRealTimers(); });

        it("CA-10: calls onTick with remaining seconds every tickIntervalMs", () => {
            const ticks = [];
            const timer = createGameTimer({
                timeLimitSeconds: 20,
                tickIntervalMs: 5_000,
                onTick: (remaining) => ticks.push(remaining),
                onExpire: () => { },
            });

            timer.start();

            // Advance 5s → first tick
            jest.advanceTimersByTime(5_000);
            expect(ticks).toEqual([15]);

            // Advance another 5s → second tick
            jest.advanceTimersByTime(5_000);
            expect(ticks).toEqual([15, 10]);

            // Advance another 5s → third tick
            jest.advanceTimersByTime(5_000);
            expect(ticks).toEqual([15, 10, 5]);

            timer.stop();
        });

        it("CA-10: does not call onTick after stop", () => {
            const ticks = [];
            const timer = createGameTimer({
                timeLimitSeconds: 20,
                tickIntervalMs: 5_000,
                onTick: (remaining) => ticks.push(remaining),
                onExpire: () => { },
            });

            timer.start();
            jest.advanceTimersByTime(5_000);
            expect(ticks).toHaveLength(1);

            timer.stop();
            jest.advanceTimersByTime(10_000);
            expect(ticks).toHaveLength(1); // no more ticks
        });

        it("CA-10: remaining_seconds is never negative", () => {
            const ticks = [];
            const timer = createGameTimer({
                timeLimitSeconds: 7,
                tickIntervalMs: 5_000,
                onTick: (remaining) => ticks.push(remaining),
                onExpire: () => { },
            });

            timer.start();
            jest.advanceTimersByTime(5_000);
            expect(ticks).toEqual([2]);

            // Next tick would be at 10s which is past 7s limit — timer should have expired
            jest.advanceTimersByTime(5_000);
            // The tick at 10s should not fire (timer expired at 7s)
            // At most we get the tick at 5s
            for (const t of ticks) {
                expect(t).toBeGreaterThanOrEqual(0);
            }

            timer.stop();
        });
    });

    // ── onExpire callback (CA-11) ─────────────────────────────────────────────

    describe("onExpire — CA-11", () => {
        beforeEach(() => { jest.useFakeTimers(); });
        afterEach(() => { jest.useRealTimers(); });

        it("CA-11: calls onExpire exactly once when time_limit is reached", () => {
            let expireCount = 0;
            const timer = createGameTimer({
                timeLimitSeconds: 10,
                tickIntervalMs: 5_000,
                onTick: () => { },
                onExpire: () => { expireCount++; },
            });

            timer.start();
            jest.advanceTimersByTime(10_000);

            expect(expireCount).toBe(1);
        });

        it("CA-11: isRunning returns false after expiration", () => {
            const timer = createGameTimer({
                timeLimitSeconds: 5,
                tickIntervalMs: 5_000,
                onTick: () => { },
                onExpire: () => { },
            });

            timer.start();
            jest.advanceTimersByTime(5_000);

            expect(timer.isRunning()).toBe(false);
        });

        it("CA-11: stops tick interval after expiration", () => {
            const ticks = [];
            const timer = createGameTimer({
                timeLimitSeconds: 10,
                tickIntervalMs: 5_000,
                onTick: (remaining) => ticks.push(remaining),
                onExpire: () => { },
            });

            timer.start();
            jest.advanceTimersByTime(10_000); // expire
            const tickCountAtExpire = ticks.length;

            jest.advanceTimersByTime(10_000); // well past expiration
            expect(ticks.length).toBe(tickCountAtExpire); // no new ticks
        });

        it("onExpire is not called if stop is called before expiration", () => {
            let expired = false;
            const timer = createGameTimer({
                timeLimitSeconds: 10,
                tickIntervalMs: 5_000,
                onTick: () => { },
                onExpire: () => { expired = true; },
            });

            timer.start();
            jest.advanceTimersByTime(3_000);
            timer.stop(); // manual stop before expiration

            jest.advanceTimersByTime(10_000);
            expect(expired).toBe(false);
        });
    });

    // ── startedAt (CA-9) ──────────────────────────────────────────────────────

    describe("startedAt — CA-9", () => {
        it("CA-9: start returns an ISO 8601 startedAt timestamp", () => {
            const timer = createGameTimer({
                timeLimitSeconds: 30,
                onTick: () => { },
                onExpire: () => { },
            });

            const result = timer.start();
            expect(result).toHaveProperty("startedAt");
            expect(new Date(result.startedAt).toISOString()).toBe(result.startedAt);

            timer.stop();
        });
    });

    // ── Default tickIntervalMs ─────────────────────────────────────────────────

    describe("default tickIntervalMs", () => {
        beforeEach(() => { jest.useFakeTimers(); });
        afterEach(() => { jest.useRealTimers(); });

        it("defaults to 5000ms tick interval", () => {
            const ticks = [];
            const timer = createGameTimer({
                timeLimitSeconds: 30,
                onTick: (remaining) => ticks.push(remaining),
                onExpire: () => { },
            });

            timer.start();
            jest.advanceTimersByTime(5_000);
            expect(ticks).toHaveLength(1);
            expect(ticks[0]).toBe(25);

            timer.stop();
        });
    });

    // ── Edge cases ─────────────────────────────────────────────────────────────

    describe("edge cases", () => {
        beforeEach(() => { jest.useFakeTimers(); });
        afterEach(() => { jest.useRealTimers(); });

        it("timeLimitSeconds of 5 expires before any tick with 5s interval", () => {
            const ticks = [];
            let expired = false;
            const timer = createGameTimer({
                timeLimitSeconds: 5,
                tickIntervalMs: 5_000,
                onTick: (remaining) => ticks.push(remaining),
                onExpire: () => { expired = true; },
            });

            timer.start();
            jest.advanceTimersByTime(5_000);

            // The expiration fires at 5s. The tick at 5s would give 0 remaining —
            // either it fires before expire or not, but expire must have been called.
            expect(expired).toBe(true);
        });

        it("very short time limit (< tick interval) expires correctly", () => {
            let expired = false;
            const timer = createGameTimer({
                timeLimitSeconds: 2,
                tickIntervalMs: 5_000,
                onTick: () => { },
                onExpire: () => { expired = true; },
            });

            timer.start();
            jest.advanceTimersByTime(2_000);
            expect(expired).toBe(true);
            expect(timer.isRunning()).toBe(false);
        });
    });
});