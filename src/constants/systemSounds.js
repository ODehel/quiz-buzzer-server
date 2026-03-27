/**
 * Set of all valid system sound identifiers (US-018).
 * These are auto-triggered at specific game events,
 * or can be manually triggered via the 'trigger_system_sound' WS message.
 */
export const SYSTEM_SOUNDS = new Set([
  "BUZZ_PRESSED",
  "BUZZ_LOCKED",
  "BUZZ_INVALIDATED",
  "CORRECT_ANSWER",
  "WRONG_ANSWER",
  "TIMER_END",
  "GAME_START",
  "GAME_END",
  "WAITING",
  "SUSPENSE",
]);
