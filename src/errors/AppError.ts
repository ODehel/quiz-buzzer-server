/**
 * Erreur applicative standardisée.
 * Produit la réponse JSON décrite dans le catalogue d'erreurs.
 */
export class AppError extends Error {
  status: number;
  error: string;

  /**
   * @param status - Code HTTP (400, 401, 405, 415, 429, 500)
   * @param error  - Code erreur (VALIDATION_ERROR, INVALID_CREDENTIALS, …)
   * @param message - Message humain
   */
  constructor(status: number, error: string, message: string) {
    super(message);
    this.status = status;
    this.error = error;
  }

  toJSON(): { status: number; error: string; message: string } {
    return {
      status: this.status,
      error: this.error,
      message: this.message,
    };
  }
}
