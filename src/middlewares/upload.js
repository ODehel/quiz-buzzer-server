import multer from "multer";

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Creates a multer middleware using in-memory storage.
 * Files are available in req.file.buffer after parsing.
 * Using memoryStorage avoids ordering issues with multipart fields.
 *
 * @returns {import("multer").Multer}
 */
export function createUploadMiddleware() {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE_BYTES },
  });
}
