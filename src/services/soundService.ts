import fs from "node:fs/promises";
import path from "node:path";
import { v7 as uuidv7 } from "uuid";
import { AppError } from "../errors/AppError.ts";
import {
  insertSound,
  findSoundById,
  findSoundByName,
  findAllSounds,
  deleteSound,
} from "../repositories/soundRepository.ts";
import { getExtensionFromMime } from "../middlewares/upload.ts";
import { logInfo, logWarn } from "../utils/logger.ts";
import { validateUuid, normalizeName } from "../utils/validation.ts";
import Database from "better-sqlite3";
import type { SoundRow, SoundApiResponse, PaginatedResponse, UploadedFile } from "../types/index.ts";

export { validateUuid, normalizeName };

/**
 * Mappe une ligne DB vers le format JSON de l'API.
 */
function toApiFormat(row: SoundRow): SoundApiResponse {
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
export async function createSound(
  db: Database.Database,
  name: string,
  file: UploadedFile,
  uploadsDir: string,
): Promise<SoundApiResponse> {
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
export function getSound(db: Database.Database, id: string): SoundApiResponse {
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
export function listSounds(db: Database.Database, page: number, limit: number): PaginatedResponse<SoundApiResponse> {
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
export async function deleteSoundById(db: Database.Database, id: string, uploadsDir: string): Promise<void> {
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
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logWarn("SOUND_DELETE_FILE_ERROR", {
        sound_id: id,
        filename: row.SND_FILENAME,
        error: (err as Error).message,
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
