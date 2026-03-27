import path from "node:path";
import fs from "node:fs/promises";
import Busboy from "busboy";
import { AppError } from "../errors/AppError.js";
import { logInfo } from "../utils/logger.js";

// Supported MIME types per media type
const SUPPORTED_MIMES = {
  image: new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  audio: new Set(["audio/mpeg", "audio/wav", "audio/wave", "audio/ogg"]),
};

// Extension mapping for MIME types
const MIME_TO_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/wave": ".wav",
  "audio/ogg": ".ogg",
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Creates an upload directory if it doesn't exist
 * @param {string} uploadsDir - Directory path
 */
export async function ensureUploadsDirectory(uploadsDir) {
  try {
    await fs.mkdir(uploadsDir, { recursive: true });
  } catch (err) {
    console.error(`Failed to create uploads directory: ${err.message}`);
  }
}

/**
 * Validates if the MIME type matches the declared media type
 * @param {string} mimeType - MIME type of the file
 * @param {string} mediaType - Declared media type (image or audio)
 * @throws {AppError} 400 INVALID_MEDIA_TYPE if mismatch
 */
function validateMimeTypeMatch(mimeType, mediaType) {
  if (!SUPPORTED_MIMES[mediaType]?.has(mimeType)) {
    throw new AppError(
      400,
      "INVALID_MEDIA_TYPE",
      `File MIME type '${mimeType}' does not match declared media type '${mediaType}'.`
    );
  }
}

/**
 * Parses multipart/form-data from request and validates file upload
 * @param {Object} req - HTTP request
 * @returns {Promise<Object>} { type: string, file: { buffer, mimetype, size } }
 * @throws {AppError} Various validation errors
 */
export async function parseMultipartFormData(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_SIZE } });
    let fileField = null;
    let typeField = null;
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
      if (fieldname === "type") {
        typeField = val;
      }
    });

    bb.on("close", () => {
      try {
        // Check file size limit (truncation by Busboy limits)
        if (fileTruncated) {
          throw new AppError(413, "FILE_TOO_LARGE", "File size exceeds the 10MB limit.");
        }

        // Validate file field
        if (!fileField) {
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            "The 'file' field is required in the multipart form."
          );
        }

        // Validate type field
        if (!typeField) {
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            "The 'type' field is required in the multipart form."
          );
        }

        if (!["image", "audio"].includes(typeField)) {
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            "The 'type' field must be either 'image' or 'audio'."
          );
        }

        // Validate MIME type matches declared type
        validateMimeTypeMatch(fileMimetype, typeField);

        resolve({
          type: typeField,
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

/**
 * Gets file extension from MIME type
 * @param {string} mimeType - MIME type
 * @returns {string} File extension (e.g., '.jpg')
 */
export function getExtensionFromMime(mimeType) {
  return MIME_TO_EXT[mimeType] || ".bin";
}

/**
 * Checks if a media type is valid
 * @param {string} type - Media type to check
 * @returns {boolean}
 */
export function isValidMediaType(type) {
  return ["image", "audio"].includes(type);
}
