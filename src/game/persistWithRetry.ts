/**
 * Exécute une fonction de persistance avec retry et backoff exponentiel (CA-34).
 *
 * En cas d'échec après maxRetries tentatives, rejette avec l'erreur d'origine (CA-35).
 */

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

export function persistWithRetry(fn: () => void, { maxRetries = 3, baseDelayMs = 100 }: RetryOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    function tryOnce(): void {
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
