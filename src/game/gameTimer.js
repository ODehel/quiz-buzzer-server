/**
 * Chronomètre hybride pour le workflow MCQ (CA-9, CA-10, CA-11).
 *
 * Approche :
 * - Un setInterval émet des ticks de resynchronisation (par défaut toutes les 5s)
 * - Un setTimeout déclenche l'expiration au bout de time_limit secondes
 * - Les callbacks onTick et onExpire sont injectées (DIP)
 *
 * Le chronomètre fait autorité côté serveur : les clients calculent
 * localement le temps restant à partir de started_at, et corrigent
 * leur dérive grâce aux ticks.
 */

/**
 * Crée un chronomètre de question.
 *
 * @param {Object} options
 * @param {number} options.timeLimitSeconds - Durée totale en secondes
 * @param {number} [options.tickIntervalMs=5000] - Intervalle entre les ticks en ms
 * @param {(remainingSeconds: number) => void} options.onTick - Callback à chaque tick
 * @param {() => void} options.onExpire - Callback à expiration
 * @returns {{ start: () => { startedAt: string }, stop: () => void, isRunning: () => boolean }}
 */
export function createGameTimer({
  timeLimitSeconds,
  tickIntervalMs = 5_000,
  onTick,
  onExpire,
}) {
  let tickInterval = null;
  let expireTimeout = null;
  let running = false;
  let startTime = null;

  function cleanup() {
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

  function start() {
    const startedAt = new Date().toISOString();
    startTime = Date.now();
    running = true;

    // Tick interval (CA-10)
    tickInterval = setInterval(() => {
      if (!running) return;
      const elapsedMs = Date.now() - startTime;
      const remainingSeconds = Math.max(0, Math.ceil(timeLimitSeconds - elapsedMs / 1000));
      onTick(remainingSeconds);
    }, tickIntervalMs);

    // Expiration timeout (CA-11)
    expireTimeout = setTimeout(() => {
      cleanup();
      onExpire();
    }, timeLimitSeconds * 1000);

    return { startedAt };
  }

  function stop() {
    cleanup();
  }

  function isRunning() {
    return running;
  }

  return { start, stop, isRunning };
}