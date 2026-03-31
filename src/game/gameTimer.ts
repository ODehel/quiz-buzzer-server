/**
 * Chronomètre hybride pour le workflow MCQ et SPEED.
 *
 * Approche :
 * - Un setInterval émet des ticks de resynchronisation (par défaut toutes les 5s)
 * - Un setTimeout déclenche l'expiration au bout de time_limit secondes
 * - Les callbacks onTick et onExpire sont injectées (DIP)
 *
 * Pour les questions SPEED, le chronomètre supporte la suspension (buzz)
 * et la reprise (invalidation) via suspend() et resume().
 */

import type { IGameTimer } from "../types/index.ts";

interface GameTimerOptions {
  timeLimitSeconds: number;
  tickIntervalMs?: number;
  onTick: (remainingSeconds: number) => void;
  onExpire: () => void;
}

/**
 * Crée un chronomètre de question.
 */
export function createGameTimer({
  timeLimitSeconds,
  tickIntervalMs = 5_000,
  onTick,
  onExpire,
}: GameTimerOptions): IGameTimer {
  let tickInterval: ReturnType<typeof setInterval> | null = null;
  let expireTimeout: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let startTime: number | null = null;
  /** Remaining ms saved when suspended (SPEED buzz) */
  let remainingMs: number | null = null;

  function cleanup(): void {
    if (tickInterval !== null) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
    if (expireTimeout !== null) {
      clearTimeout(expireTimeout);
      expireTimeout = null;
    }
    running = false;
  }

  /**
   * Starts the timers from the beginning (full timeLimitSeconds).
   */
  function start(): { startedAt: string } {
    const startedAt = new Date().toISOString();
    remainingMs = timeLimitSeconds * 1000;
    startTime = Date.now();
    running = true;

    tickInterval = setInterval(() => {
      if (!running) return;
      const elapsedMs = Date.now() - startTime!;
      const remainingSeconds = Math.max(0, Math.ceil((remainingMs! - elapsedMs) / 1000));
      onTick(remainingSeconds);
    }, tickIntervalMs);

    expireTimeout = setTimeout(() => {
      cleanup();
      remainingMs = 0;
      onExpire();
    }, remainingMs);

    return { startedAt };
  }

  /**
   * Suspends the timer (CA-11, CA-13). Memorizes remaining time.
   * Used when a buzzer buzzes during a SPEED question.
   */
  function suspend(): number {
    if (!running) return remainingMs ?? 0;
    const elapsed = Date.now() - startTime!;
    remainingMs = Math.max(0, remainingMs! - elapsed);
    cleanup();
    return remainingMs;
  }

  /**
   * Resumes the timer with the remaining time (CA-12).
   * Used after an invalidation in SPEED mode.
   */
  function resume(): void {
    if (running || remainingMs == null || remainingMs <= 0) return;

    startTime = Date.now();
    running = true;

    tickInterval = setInterval(() => {
      if (!running) return;
      const elapsedMs = Date.now() - startTime!;
      const remainingSeconds = Math.max(0, Math.ceil((remainingMs! - elapsedMs) / 1000));
      onTick(remainingSeconds);
    }, tickIntervalMs);

    expireTimeout = setTimeout(() => {
      cleanup();
      remainingMs = 0;
      onExpire();
    }, remainingMs);
  }

  function stop(): void {
    cleanup();
  }

  function isRunning(): boolean {
    return running;
  }

  /**
   * Returns the current remaining time in milliseconds.
   */
  function getRemainingMs(): number {
    if (running && startTime != null) {
      const elapsed = Date.now() - startTime;
      return Math.max(0, remainingMs! - elapsed);
    }
    return remainingMs ?? 0;
  }

  return { start, stop, isRunning, suspend, resume, getRemainingMs };
}
