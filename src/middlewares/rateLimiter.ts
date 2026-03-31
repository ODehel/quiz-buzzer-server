import { IRateLimiter, RateLimitCheck } from "../types/index.ts";

/**
 * Rate limiter in-memory par adresse IP.
 * Conçu comme une classe pour permettre l'injection/reset dans les tests.
 */
export class RateLimiter implements IRateLimiter {
  private maxRequests: number;
  private windowMs: number;
  private ipMap: Map<string, number[]>;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.ipMap = new Map();
  }

  /**
   * Vérifie si la requête est autorisée pour cette IP.
   */
  check(ip: string): RateLimitCheck {
    const now = Date.now();

    if (!this.ipMap.has(ip)) {
      this.ipMap.set(ip, []);
    }

    // Nettoyer les timestamps hors fenêtre
    const timestamps = this.ipMap
      .get(ip)!
      .filter((t: number) => now - t < this.windowMs);
    this.ipMap.set(ip, timestamps);

    if (timestamps.length >= this.maxRequests) {
      return { allowed: false, retryAfter: Math.ceil(this.windowMs / 1000) };
    }

    timestamps.push(now);
    return { allowed: true };
  }

  /** Réinitialise l'état (utile pour les tests). */
  reset(): void {
    this.ipMap.clear();
  }
}
