/**
 * Erreur applicative standardisée.
 * Produit la réponse JSON décrite dans le catalogue d'erreurs.
 */
export class AppError extends Error {
  /**
   * @param {number} status - Code HTTP (400, 401, 405, 415, 429, 500)
   * @param {string} error  - Code erreur (VALIDATION_ERROR, INVALID_CREDENTIALS, …)
   * @param {string} message - Message humain
   */
  constructor(status, error, message) {
    super(message);
    this.status = status;
    this.error = error;
  }

  /** @returns {{ status: number, error: string, message: string }} */
  toJSON() {
    return {
      status: this.status,
      error: this.error,
      message: this.message,
    };
  }
}