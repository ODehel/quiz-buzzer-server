/**
 * Exécute une fonction de persistance avec retry et backoff exponentiel (CA-34).
 *
 * En cas d'échec après maxRetries tentatives, rejette avec l'erreur d'origine (CA-35).
 *
 * @param {() => void} fn - Fonction synchrone de persistance (transaction SQLite)
 * @param {Object} [options]
 * @param {number} [options.maxRetries=3] - Nombre max de tentatives
 * @param {number} [options.baseDelayMs=100] - Délai de base en ms (doublé à chaque retry)
 * @returns {Promise<void>}
 */
export function persistWithRetry(fn, { maxRetries = 3, baseDelayMs = 100 } = {}) {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    function tryOnce() {
      attempt++;
      try {
        fn();
        resolve();
      } catch (err) {
        if (attempt >= maxRetries) {
          reject(err);
          return;
        }
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        setTimeout(tryOnce, delay);
      }
    }

    tryOnce();
  });
}