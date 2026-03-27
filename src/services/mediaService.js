import { promises as fs } from "node:fs";
import path from "node:path";
import { logWarn } from "../utils/logger.js";

export const UPLOADS_ROOT = path.resolve("uploads");
export const QUESTIONS_UPLOAD_DIR = path.join(UPLOADS_ROOT, "questions");
export const SOUNDS_UPLOAD_DIR = path.join(UPLOADS_ROOT, "sounds");

export const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
export const AUDIO_MIMES = new Set(["audio/mpeg", "audio/wav", "audio/ogg"]);

const MIME_TO_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
};

/**
 * Returns true if the mimetype is allowed for the declared media type.
 * @param {"image"|"audio"} declaredType
 * @param {string} mimetype
 */
export function isMimeAllowed(declaredType, mimetype) {
  if (declaredType === "image") return IMAGE_MIMES.has(mimetype);
  if (declaredType === "audio") return AUDIO_MIMES.has(mimetype);
  return false;
}

/**
 * Returns the file extension for a MIME type, or null if unknown.
 * @param {string} mimetype
 * @returns {string|null}
 */
export function getExtension(mimetype) {
  return MIME_TO_EXT[mimetype] ?? null;
}

/**
 * Creates the upload directories if they don't exist.
 */
export async function ensureUploadDirs() {
  await fs.mkdir(QUESTIONS_UPLOAD_DIR, { recursive: true });
  await fs.mkdir(SOUNDS_UPLOAD_DIR, { recursive: true });
}

/**
 * Deletes a file silently (swallows errors, logs a warning).
 * @param {string} filePath
 * @param {string} logEvent
 * @param {Object} logData
 */
export async function deleteFileSilently(filePath, logEvent, logData) {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    logWarn(logEvent, { ...logData, error: err.message });
  }
}

/**
 * Writes a buffer to a file path.
 * @param {string} filePath
 * @param {Buffer} buffer
 */
export async function writeFile(filePath, buffer) {
  await fs.writeFile(filePath, buffer);
}
