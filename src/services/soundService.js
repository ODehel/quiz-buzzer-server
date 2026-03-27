import fs from "node:fs/promises";
import path from "node:path";
import { v7 as uuidv7 } from "uuid";
import { AppError } from "../errors/AppError.js";
import {
  insertSound,
  findSoundById,
  findSoundByName,
  findAllSounds,
  deleteSound,
} from "../repositories/soundRepository.js";
import { getExtensionFromMime } from "../middlewares/upload.js";
import { logInfo, logWarn } from "../utils/logger.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Valide qu'un ID est un UUID valide.
 * @param {string} id
 * @throws {AppError} 400 INVALID_UUID
 */
export function validateUuid(id) {
  if (!UUID_REGEX.test(id)) {
    throw new AppError(400, "INVALID_UUID", "The provided ID is not a valid UUID.");
  }
}

/**
 * Normalise un nom : trim + collapse des espaces multiples (CA-3).
 * @param {string} name
 * @returns {string}
 */
export function normalizeName(name) {
  return name.trim().replace(/\s+/g, " ");
}

/**
 * Mappe une ligne DB vers le format JSON de l'API.
 */
function toApiFormat(row) {
  return {
    id: row.SND_ID,
    name: row.SND_NAME,
    filename: row.SND_FILENAME,
    url: `/uploads/sounds/${row.SND_FILENAME}`,
    created_at: row.SND_CREATED_AT,
  };
}

/**
 * Crée un nouveau son (CA-1 à CA-9).
 */
export async function createSound(db, name, file, uploadsDir) {
  const normalized = normalizeName(name);

  // CA-4: Validation longueur
  if (!normalized || normalized.length < 1 || normalized.length > 100) {
    throw new AppError(400, "VALIDATION_ERROR", "Sound name must be between 1 and 100 characters.");
  }

  // CA-9: Unicité insensible à la casse
  const existing = findSoundByName(db, normalized);
  if (existing) {
    throw new AppError(409, "SOUND_ALREADY_EXISTS", "A sound with this name already exists.");
  }

  const id = uuidv7();
  const now = new Date().toISOString();
  const extension = getExtensionFromMime(file.mimetype);
  const filename = `${id}${extension}`;

  // CA-2: Écriture physique du fichier
  const soundsDir = path.join(uploadsDir, "sounds");
  await fs.mkdir(soundsDir, { recursive: true });
  await fs.writeFile(path.join(soundsDir, filename), file.buffer);

  // Insertion en base
  insertSound(db, { id, name: normalized, filename, createdAt: now });

  logInfo("SOUND_UPLOADED", {
    sound_id: id,
    name: normalized,
    filename,
    size_bytes: file.size,
  });

  return toApiFormat({
    SND_ID: id,
    SND_NAME: normalized,
    SND_FILENAME: filename,
    SND_CREATED_AT: now,
  });
}

/**
 * Récupère un son par ID (CA-15 à CA-17).
 */
export function getSound(db, id) {
  validateUuid(id);
  const row = findSoundById(db, id);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", "The requested sound was not found.");
  }
  return toApiFormat(row);
}

/**
 * Liste les sons avec pagination (CA-11 à CA-14).
 */
export function listSounds(db, page, limit) {
  const { data, total } = findAllSounds(db, page, limit);
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

  return {
    data: data.map(toApiFormat),
    page,
    limit,
    total,
    total_pages: totalPages,
  };
}

/**
 * Supprime un son (CA-18 à CA-21).
 */
export async function deleteSoundById(db, id, uploadsDir) {
  validateUuid(id);

  const row = findSoundById(db, id);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", "The requested sound was not found.");
  }

  // Suppression en base d'abord
  deleteSound(db, id);

  // CA-21: Suppression physique tolérante
  const filePath = path.join(uploadsDir, "sounds", row.SND_FILENAME);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      logWarn("SOUND_DELETE_FILE_ERROR", {
        sound_id: id,
        filename: row.SND_FILENAME,
        error: err.message,
      });
    } else {
      logWarn("SOUND_DELETE_FILE_ERROR", {
        sound_id: id,
        filename: row.SND_FILENAME,
        error: "File not found on disk",
      });
    }
  }

  logInfo("SOUND_DELETED", {
    sound_id: id,
    name: row.SND_NAME,
    filename: row.SND_FILENAME,
  });
}
