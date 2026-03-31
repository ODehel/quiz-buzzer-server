import { QuestionRow, QuestionApiResponse } from "../types/index.ts";
import { validateUuid, normalizeName as normalizeTitle, parsePagination } from "../utils/validation.ts";

export { validateUuid, normalizeTitle, parsePagination };

/**
 * Mappe une ligne DB vers le format JSON de l'API.
 * Pour une question SPEED, le champ choices est absent.
 */
export function toApiFormat(row: QuestionRow): QuestionApiResponse {
  const result: QuestionApiResponse = {
    id: row.QST_ID,
    type: row.QST_TYPE,
    theme_id: row.QST_THEME_ID,
    theme_name: row.THM_NAME ?? null,
    title: row.QST_TITLE,
    correct_answer: row.QST_CORRECT_ANSWER,
    level: row.QST_LEVEL,
    time_limit: row.QST_TIME_LIMIT,
    points: row.QST_POINTS,
    image_path: row.QST_IMAGE_PATH ?? null,
    audio_path: row.QST_AUDIO_PATH ?? null,
    created_at: row.QST_CREATED_AT,
    last_updated_at: row.QST_LAST_UPDATED_AT ?? null,
  };

  if (row.QST_TYPE === "MCQ") {
    result.choices = [row.QST_CHOICE_A!, row.QST_CHOICE_B!, row.QST_CHOICE_C!, row.QST_CHOICE_D!];
  }

  return result;
}

interface QuestionUpdateFields {
  themeId?: string;
  title?: string;
  choiceA?: string | null;
  choiceB?: string | null;
  choiceC?: string | null;
  choiceD?: string | null;
  correctAnswer?: string;
  level?: number;
  timeLimit?: number;
  points?: number;
  imagePath?: string | null;
  audioPath?: string | null;
}

/**
 * Détecte si deux états de question sont identiques (pour éviter une mise à jour inutile).
 */
export function isIdentical(row: QuestionRow, fields: QuestionUpdateFields): boolean {
  const lowerOf = (s: string | null | undefined): string => (s ?? "").toLowerCase();
  if (fields.themeId !== undefined && lowerOf(row.QST_THEME_ID) !== lowerOf(fields.themeId)) return false;
  if (fields.title !== undefined && lowerOf(row.QST_TITLE) !== lowerOf(fields.title)) return false;
  if (fields.correctAnswer !== undefined && lowerOf(row.QST_CORRECT_ANSWER) !== lowerOf(fields.correctAnswer)) return false;
  if (fields.level !== undefined && row.QST_LEVEL !== fields.level) return false;
  if (fields.timeLimit !== undefined && row.QST_TIME_LIMIT !== fields.timeLimit) return false;
  if (fields.points !== undefined && row.QST_POINTS !== fields.points) return false;
  if (fields.choiceA !== undefined && lowerOf(row.QST_CHOICE_A) !== lowerOf(fields.choiceA)) return false;
  if (fields.choiceB !== undefined && lowerOf(row.QST_CHOICE_B) !== lowerOf(fields.choiceB)) return false;
  if (fields.choiceC !== undefined && lowerOf(row.QST_CHOICE_C) !== lowerOf(fields.choiceC)) return false;
  if (fields.choiceD !== undefined && lowerOf(row.QST_CHOICE_D) !== lowerOf(fields.choiceD)) return false;
  // Optional path fields: null must compare equal to null (not masked by string conversion)
  if (fields.imagePath !== undefined) {
    const stored = row.QST_IMAGE_PATH ?? null;
    if (stored !== fields.imagePath) return false;
  }
  if (fields.audioPath !== undefined) {
    const stored = row.QST_AUDIO_PATH ?? null;
    if (stored !== fields.audioPath) return false;
  }
  return true;
}
