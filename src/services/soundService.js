import { v7 as uuidv7 } from "uuid";
import path from "node:path";
import { AppError } from "../errors/AppError.js";
import {
  insertSound,
  findSoundById,
  findSoundByName,
  findSounds,
  deleteSoundById,
} from "../repositories/soundRepository.js";
import {
  SOUNDS_UPLOAD_DIR,
  AUDIO_MIMES,
  getExtension,
  writeFile,
  deleteFileSilently,
} from "./mediaService.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LEN = 100;

function validateUuid(id) {
  if (!UUID_REGEX.test(id)) {
    throw new AppError(400, "INVALID_UUID", "The provided ID is not a valid UUID.");
  }
}

function toApiFormat(row) {
  return {
    id: row.SND_ID,
    name: row.SND_NAME,
    filename: row.SND_FILENAME,
    created_at: row.SND_CREATED_AT,
  };
}

/**
 * Normalizes a jingle name: trim + collapse whitespace.
 * @param {string} name
 * @returns {string}
 */
export function normalizeName(name) {
  return name.trim().replace(/\s+/g, " ");
}

/**
 * Parses and validates pagination parameters from a URL.
 * @param {URL} url
 * @returns {{ page: number, limit: number }}
 */
export function parsePagination(url) {
  const rawPage = url.searchParams.get("page");
  const rawLimit = url.searchParams.get("limit");
  const page = rawPage !== null ? Number(rawPage) : 1;
  const limit = rawLimit !== null ? Number(rawLimit) : 20;
  if (
    !Number.isInteger(page) || page < 1 ||
    !Number.isInteger(limit) || limit < 1 || limit > 100
  ) {
    throw new AppError(400, "INVALID_PAGINATION", "Invalid pagination parameters.");
  }
  return { page, limit };
}

/**
 * Uploads a jingle and stores its metadata.
 * @param {import("better-sqlite3").Database} db
 * @param {{ name: string, mimetype: string, buffer: Buffer }} params
 * @returns {Promise<Object>}
 */
export async function uploadSound(db, { name, mimetype, buffer }) {
  if (!name || typeof name !== "string") {
    throw new AppError(400, "VALIDATION_ERROR", "name is required.");
  }
  const normalized = normalizeName(name);
  if (normalized.length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "name must not be empty.");
  }
  if (normalized.length > MAX_NAME_LEN) {
    throw new AppError(400, "VALIDATION_ERROR", `name must not exceed ${MAX_NAME_LEN} characters.`);
  }

  const existing = findSoundByName(db, normalized);
  if (existing) {
    throw new AppError(409, "SOUND_ALREADY_EXISTS", "A jingle with this name already exists.");
  }

  if (!AUDIO_MIMES.has(mimetype)) {
    throw new AppError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Only audio/mpeg, audio/wav, and audio/ogg files are accepted."
    );
  }

  const ext = getExtension(mimetype);
  const id = uuidv7();
  const filename = `${id}.${ext}`;
  const filePath = path.join(SOUNDS_UPLOAD_DIR, filename);

  await writeFile(filePath, buffer);

  const createdAt = new Date().toISOString();
  insertSound(db, { id, name: normalized, filename, createdAt });

  return toApiFormat({ SND_ID: id, SND_NAME: normalized, SND_FILENAME: filename, SND_CREATED_AT: createdAt });
}

/**
 * Lists jingles with pagination.
 * @param {import("better-sqlite3").Database} db
 * @param {number} page
 * @param {number} limit
 * @returns {Object}
 */
export function listSounds(db, page, limit) {
  const { data, total } = findSounds(db, page, limit);
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return { data: data.map(toApiFormat), page, limit, total, total_pages: totalPages };
}

/**
 * Gets a jingle by ID.
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @returns {Object}
 */
export function getSound(db, id) {
  validateUuid(id);
  const row = findSoundById(db, id);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", "The requested jingle was not found.");
  }
  return toApiFormat(row);
}

/**
 * Deletes a jingle by ID (DB record + physical file).
 * @param {import("better-sqlite3").Database} db
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteSound(db, id) {
  validateUuid(id);
  const row = findSoundById(db, id);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", "The requested jingle was not found.");
  }
  const filePath = path.join(SOUNDS_UPLOAD_DIR, row.SND_FILENAME);
  deleteSoundById(db, id);
  await deleteFileSilently(filePath, "SOUND_FILE_DELETE_FAILED", { sound_id: id });
}
