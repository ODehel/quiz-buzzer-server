import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors/AppError.ts";
import { logInfo, logWarn } from "../utils/logger.ts";
import { findQuestionById, updateQuestion } from "../repositories/questionRepository.ts";
import { getExtensionFromMime } from "../middlewares/upload.ts";
import Database from "better-sqlite3";
import { QuestionRow, UploadedFile } from "../types/index.ts";

/**
 * Generates the filename for a media file
 */
export function generateMediaFileName(questionId: string, mediaType: string, extension: string): string {
  return `${questionId}-${mediaType}${extension}`;
}

/**
 * Generates the relative path for a media file
 */
export function generateMediaPath(questionId: string, mediaType: string, extension: string): string {
  const filename = generateMediaFileName(questionId, mediaType, extension);
  return `/uploads/questions/${filename}`;
}

/**
 * Deletes a physical media file
 */
export async function deleteMediaFile(uploadsDir: string, mediaPath: string | null): Promise<boolean> {
  if (!mediaPath) {
    return false;
  }

  try {
    // Convert relative path to absolute path
    const filename = path.basename(mediaPath);
    const absolutePath = path.join(uploadsDir, "questions", filename);

    await fs.unlink(absolutePath);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // File doesn't exist - not an error
      return false;
    }
    logWarn("MEDIA_DELETE_FILE_ERROR", {
      media_path: mediaPath,
      error: (err as Error).message,
    });
    // Continue operation even if file deletion fails
    return false;
  }
}

/**
 * Uploads a media file for a question
 */
export async function uploadMedia(
  db: Database.Database,
  questionId: string,
  mediaType: string,
  file: UploadedFile,
  uploadsDir: string,
): Promise<QuestionRow> {
  // Validate question exists
  const question = findQuestionById(db, questionId);
  if (!question) {
    throw new AppError(404, "NOT_FOUND", "The requested question was not found.");
  }

  // Generate filename and path
  const extension = getExtensionFromMime(file.mimetype);
  const filename = generateMediaFileName(questionId, mediaType, extension);
  const relativePath = generateMediaPath(questionId, mediaType, extension);
  const absolutePath = path.join(uploadsDir, "questions", filename);

  // Delete old file if it exists
  const oldMediaField = mediaType === "image" ? "QST_IMAGE_PATH" : "QST_AUDIO_PATH";
  const oldMediaPath = question[oldMediaField];
  if (oldMediaPath) {
    await deleteMediaFile(uploadsDir, oldMediaPath);
    logInfo("MEDIA_REPLACED", {
      question_id: questionId,
      media_type: mediaType,
      old_filename: path.basename(oldMediaPath),
      new_filename: filename,
    });
  }

  // Write new file to disk
  try {
    await fs.mkdir(path.join(uploadsDir, "questions"), { recursive: true });
    await fs.writeFile(absolutePath, file.buffer);
  } catch (err: unknown) {
    throw new AppError(
      500,
      "INTERNAL_SERVER_ERROR",
      "Failed to save the media file. Please try again later."
    );
  }

  // Update database
  const now = new Date().toISOString();
  // Convert snake_case to camelCase for updateQuestion
  const updateField = mediaType === "image" ? "imagePath" : "audioPath";
  const updates = { [updateField]: relativePath };
  updateQuestion(db, questionId, updates, now);

  logInfo("MEDIA_UPLOADED", {
    question_id: questionId,
    media_type: mediaType,
    filename,
    mime_type: file.mimetype,
    size_bytes: file.size,
  });

  // Return updated question
  return findQuestionById(db, questionId)!;
}

/**
 * Deletes a media file for a question
 */
export async function deleteMedia(
  db: Database.Database,
  questionId: string,
  mediaType: string,
  uploadsDir: string,
): Promise<void> {
  // Validate question exists
  const question = findQuestionById(db, questionId);
  if (!question) {
    throw new AppError(404, "NOT_FOUND", "The requested question was not found.");
  }

  // Check if media exists
  const mediaField = mediaType === "image" ? "QST_IMAGE_PATH" : "QST_AUDIO_PATH";
  const mediaPath = question[mediaField];
  if (!mediaPath) {
    throw new AppError(
      404,
      "NOT_FOUND",
      `No ${mediaType} found for this question.`
    );
  }

  // Delete physical file
  await deleteMediaFile(uploadsDir, mediaPath);

  // Update database
  const now = new Date().toISOString();
  // Convert snake_case to camelCase for updateQuestion
  const updateField = mediaType === "image" ? "imagePath" : "audioPath";
  const updates = { [updateField]: null };
  updateQuestion(db, questionId, updates, now);

  logInfo("MEDIA_DELETED", {
    question_id: questionId,
    media_type: mediaType,
    filename: path.basename(mediaPath),
  });
}
