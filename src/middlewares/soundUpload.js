import Busboy from "busboy";
import { AppError } from "../errors/AppError.js";

const ALLOWED_AUDIO_MIMES = new Set(["audio/mpeg", "audio/wav", "audio/ogg"]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Parses multipart/form-data for sound upload.
 * Expects fields: 'name' (text) and 'file' (audio file).
 *
 * @param {Object} req - HTTP request
 * @returns {Promise<{ name: string, file: { buffer: Buffer, mimetype: string, size: number } }>}
 * @throws {AppError} Various validation errors
 */
export function parseSoundFormData(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_SIZE } });
    let nameField = null;
    let fileField = null;
    let fileBuffer = null;
    let fileMimetype = null;
    let fileSize = 0;
    let fileTruncated = false;

    bb.on("file", (fieldname, file, info) => {
      if (fieldname === "file") {
        fileField = fieldname;
        fileMimetype = info.mimeType;

        const chunks = [];
        file.on("data", (data) => {
          chunks.push(data);
          fileSize += data.length;
        });

        file.on("limit", () => {
          fileTruncated = true;
        });

        file.on("end", () => {
          if (!fileTruncated) {
            fileBuffer = Buffer.concat(chunks);
          }
        });

        file.on("error", (err) => {
          reject(err);
        });
      }
    });

    bb.on("field", (fieldname, val) => {
      if (fieldname === "name") {
        nameField = val;
      }
    });

    bb.on("close", () => {
      try {
        // CA-8: File size limit
        if (fileTruncated) {
          throw new AppError(413, "FILE_TOO_LARGE", "File size exceeds the 10MB limit.");
        }

        // CA-5: file field required
        if (!fileField) {
          throw new AppError(400, "VALIDATION_ERROR", "The 'file' field is required in the multipart form.");
        }

        // CA-6: name field required
        if (nameField === null || nameField === undefined) {
          throw new AppError(400, "VALIDATION_ERROR", "The 'name' field is required in the multipart form.");
        }

        // CA-7: MIME type validation
        if (!ALLOWED_AUDIO_MIMES.has(fileMimetype)) {
          throw new AppError(
            400,
            "INVALID_MEDIA_TYPE",
            "File MIME type is not allowed for the declared media type."
          );
        }

        resolve({
          name: nameField,
          file: {
            buffer: fileBuffer,
            mimetype: fileMimetype,
            size: fileSize,
          },
        });
      } catch (err) {
        reject(err);
      }
    });

    bb.on("error", (err) => {
      reject(err);
    });

    req.pipe(bb);
  });
}
