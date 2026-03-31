import { AppError } from "../errors/AppError.ts";
import { AppRequest } from "../types/index.ts";

interface ValidateContentTypeOptions {
  allowMissing?: boolean;
}

/**
 * Middleware vérifiant que le Content-Type est application/json.
 * À utiliser sur les routes qui attendent du JSON en entrée (POST, PUT).
 */
export function validateContentType(req: AppRequest, options: ValidateContentTypeOptions = {}): void {
  const { allowMissing = true } = options;
  const contentType = req.headers["content-type"];
  const mimeType = contentType ? contentType.split(";")[0].trim() : "";

  // Si Content-Type est présent, il doit être application/json
  if (contentType && mimeType !== "application/json") {
    throw new AppError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be 'application/json'."
    );
  }

  // Si Content-Type est absent et allowMissing=false, c'est une erreur
  if (!contentType && !allowMissing) {
    throw new AppError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be 'application/json'."
    );
  }
}
