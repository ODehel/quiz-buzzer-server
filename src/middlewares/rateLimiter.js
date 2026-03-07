/**
 * Rate limiter in-memory par adresse IP.
 * Conçu comme une classe pour permettre l'injection/reset dans les tests.
 */
export class RateLimiter {
  /**
   * @param {number} maxRequests - Nombre max de requêtes dans la fenêtre
   * @param {number} windowMs   - Taille de la fenêtre en millisecondes
   */
  constructor(maxRequests, windowMs) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    /** @type {Map<string, number[]>} */
    this.ipMap = new Map();
  }

  /**
   * Vérifie si la requête est autorisée pour cette IP.
   *
   * @param {string} ip
   * @returns {{ allowed: boolean, retryAfter?: number }}
   */
  check(ip) {
    const now = Date.now();

    if (!this.ipMap.has(ip)) {
      this.ipMap.set(ip, []);
    }

    // Nettoyer les timestamps hors fenêtre
    const timestamps = this.ipMap
      .get(ip)
      .filter((t) => now - t < this.windowMs);
    this.ipMap.set(ip, timestamps);

    if (timestamps.length >= this.maxRequests) {
      return { allowed: false, retryAfter: Math.ceil(this.windowMs / 1000) };
    }

    timestamps.push(now);
    return { allowed: true };
  }

  /** Réinitialise l'état (utile pour les tests). */
  reset() {
    this.ipMap.clear();
  }
}