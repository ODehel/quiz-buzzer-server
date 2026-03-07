import { AppError } from "../errors/AppError.js";

/**
 * Middleware vérifiant que le Content-Type est application/json.
 * À utiliser sur les routes qui attendent du JSON en entrée.
 */
export function validateContentType(req) {
  const contentType = req.headers["content-type"];
  if (!contentType || !contentType.includes("application/json")) {
    throw new AppError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be 'application/json'."
    );
  }
}