import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openDatabase } from "../../src/database/database.js";
import {
  generateMediaFileName,
  generateMediaPath,
  deleteMediaFile,
  uploadMedia,
  deleteMedia,
} from "../../src/services/mediaService.js";
import { AppError } from "../../src/errors/AppError.js";

describe("mediaService.js - Unit Tests", () => {
  test("generateMediaFileName - creates correct filename", () => {
    const filename = generateMediaFileName("019d2f91-1d41-7715-aab4-6e34f5aff336", "image", ".jpg");
    expect(filename).toBe("019d2f91-1d41-7715-aab4-6e34f5aff336-image.jpg");
  });

  test("generateMediaFileName - handles audio type", () => {
    const filename = generateMediaFileName("019d2f91-1d41-7715-aab4-6e34f5aff336", "audio", ".wav");
    expect(filename).toBe("019d2f91-1d41-7715-aab4-6e34f5aff336-audio.wav");
  });

  test("generateMediaPath - creates correct relative path", () => {
    const path_result = generateMediaPath("019d2f91-1d41-7715-aab4-6e34f5aff336", "image", ".jpg");
    expect(path_result).toBe("/uploads/questions/019d2f91-1d41-7715-aab4-6e34f5aff336-image.jpg");
  });

  test("generateMediaPath - includes media type in path", () => {
    const path_result = generateMediaPath("test-id", "audio", ".mp3");
    expect(path_result).toBe("/uploads/questions/test-id-audio.mp3");
  });

  test("deleteMediaFile - returns false for null path", async () => {
    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    const result = await deleteMediaFile(uploadsDir, null);
    expect(result).toBe(false);
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  test("deleteMediaFile - returns false for undefined path", async () => {
    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    const result = await deleteMediaFile(uploadsDir, undefined);
    expect(result).toBe(false);
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  test("deleteMediaFile - returns false for empty path", async () => {
    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    const result = await deleteMediaFile(uploadsDir, "");
    expect(result).toBe(false);
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  test("deleteMediaFile - returns false if file doesn't exist", async () => {
    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    const result = await deleteMediaFile(uploadsDir, "/uploads/questions/nonexistent.jpg");
    expect(result).toBe(false);
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  test("deleteMediaFile - deletes file if it exists", async () => {
    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));

    // Create a test file
    const testFileName = "test-file.jpg";
    const absolutePath = path.join(uploadsDir, "questions", testFileName);
    await fs.mkdir(path.join(uploadsDir, "questions"), { recursive: true });
    await fs.writeFile(absolutePath, "test content");

    // Verify file exists
    await expect(fs.access(absolutePath)).resolves.toBeUndefined();

    // Delete the file
    const result = await deleteMediaFile(uploadsDir, `/uploads/questions/${testFileName}`);

    // Verify deletion
    expect(result).toBe(true);
    await expect(fs.access(absolutePath)).rejects.toThrow();

    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  test("uploadMedia - saves file and updates database", async () => {
    const db = openDatabase(":memory:");

    // Insert test data
    db.prepare("INSERT INTO T_THEME_THM VALUES (?,?,?,?)").run(
      "theme-id", "Science", "2026-03-09T10:00:00.000Z", null
    );

    const questionId = "019d2f91-1d41-7715-aab4-6e34f5aff336";
    db.prepare("INSERT INTO T_QUESTION_QST VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      questionId, "MCQ", "theme-id", "Test Question", "A", "B", "C", "D", "A", 1, 30, 10, null, null,
      "2026-03-09T10:00:00.000Z", null
    );

    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));

    const fileBuffer = Buffer.from("test image content");
    const file = {
      buffer: fileBuffer,
      mimetype: "image/jpeg",
      size: fileBuffer.length,
    };

    const result = await uploadMedia(db, questionId, "image", file, uploadsDir);

    // Verify database was updated
    expect(result.QST_IMAGE_PATH).toBeTruthy();
    expect(result.QST_IMAGE_PATH).toMatch(/^\/uploads\/questions\/.+-image\.jpg$/);
    expect(result.QST_AUDIO_PATH).toBeNull();

    // Verify file was saved
    const filename = path.basename(result.QST_IMAGE_PATH);
    const savedFilePath = path.join(uploadsDir, "questions", filename);
    const savedContent = await fs.readFile(savedFilePath, "utf-8");
    expect(savedContent).toBe("test image content");

    db.close();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  test("uploadMedia - replaces old file when uploading new one", async () => {
    const db = openDatabase(":memory:");

    db.prepare("INSERT INTO T_THEME_THM VALUES (?,?,?,?)").run(
      "theme-id", "Science", "2026-03-09T10:00:00.000Z", null
    );

    const questionId = "019d2f91-1d41-7715-aab4-6e34f5aff336";

    // Pre-populate with an existing image (null path initially, will be updated by uploadMedia)
    db.prepare("INSERT INTO T_QUESTION_QST VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      questionId, "MCQ", "theme-id", "Test Question", "A", "B", "C", "D", "A", 1, 30, 10,
      null, null,
      "2026-03-09T10:00:00.000Z", null
    );

    // Update the question to have an old image path
    db.prepare("UPDATE T_QUESTION_QST SET QST_IMAGE_PATH = ? WHERE QST_ID = ?").run(
      "/uploads/questions/old-image.jpg", questionId
    );

    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));

    // Create old file
    await fs.mkdir(path.join(uploadsDir, "questions"), { recursive: true });
    await fs.writeFile(path.join(uploadsDir, "questions", "old-image.jpg"), "old content");

    // Upload new file
    const fileBuffer = Buffer.from("new image content");
    const file = {
      buffer: fileBuffer,
      mimetype: "image/png",
      size: fileBuffer.length,
    };

    const result = await uploadMedia(db, questionId, "image", file, uploadsDir);

    // Verify new file saved and old one deleted
    expect(result.QST_IMAGE_PATH).toContain("-image.png");
    const oldFilePath = path.join(uploadsDir, "questions", "old-image.jpg");
    await expect(fs.access(oldFilePath)).rejects.toThrow();

    db.close();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  test("uploadMedia - throws 404 if question doesn't exist", async () => {
    const db = openDatabase(":memory:");

    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));

    const fileBuffer = Buffer.from("test");
    const file = {
      buffer: fileBuffer,
      mimetype: "image/jpeg",
      size: fileBuffer.length,
    };

    await expect(
      uploadMedia(db, "nonexistent-id", "image", file, uploadsDir)
    ).rejects.toThrow(AppError);

    db.close();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  test("deleteMedia - deletes file and updates database", async () => {
    const db = openDatabase(":memory:");

    db.prepare("INSERT INTO T_THEME_THM VALUES (?,?,?,?)").run(
      "theme-id", "Science", "2026-03-09T10:00:00.000Z", null
    );

    const questionId = "019d2f91-1d41-7715-aab4-6e34f5aff336";
    const imagePath = "/uploads/questions/test-image.jpg";

    db.prepare("INSERT INTO T_QUESTION_QST VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      questionId, "MCQ", "theme-id", "Test Question", "A", "B", "C", "D", "A", 1, 30, 10,
      imagePath, null,
      "2026-03-09T10:00:00.000Z", null
    );

    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));

    // Create test file
    await fs.mkdir(path.join(uploadsDir, "questions"), { recursive: true });
    await fs.writeFile(path.join(uploadsDir, "questions", "test-image.jpg"), "test");

    await deleteMedia(db, questionId, "image", uploadsDir);

    // Verify file deleted
    const filePath = path.join(uploadsDir, "questions", "test-image.jpg");
    await expect(fs.access(filePath)).rejects.toThrow();

    // Verify database updated
    const updatedQuestion = db.prepare("SELECT QST_IMAGE_PATH FROM T_QUESTION_QST WHERE QST_ID = ?").get(questionId);
    expect(updatedQuestion.QST_IMAGE_PATH).toBeNull();

    db.close();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  test("deleteMedia - throws 404 if question doesn't exist", async () => {
    const db = openDatabase(":memory:");

    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));

    await expect(
      deleteMedia(db, "nonexistent-id", "image", uploadsDir)
    ).rejects.toThrow(AppError);

    db.close();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  test("deleteMedia - throws 404 if media doesn't exist", async () => {
    const db = openDatabase(":memory:");

    db.prepare("INSERT INTO T_THEME_THM VALUES (?,?,?,?)").run(
      "theme-id", "Science", "2026-03-09T10:00:00.000Z", null
    );

    const questionId = "019d2f91-1d41-7715-aab4-6e34f5aff336";
    db.prepare("INSERT INTO T_QUESTION_QST VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      questionId, "MCQ", "theme-id", "Test Question", "A", "B", "C", "D", "A", 1, 30, 10,
      null, null,
      "2026-03-09T10:00:00.000Z", null
    );

    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));

    await expect(
      deleteMedia(db, questionId, "image", uploadsDir)
    ).rejects.toThrow(AppError);

    db.close();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  test("deleteMediaFile - handles ENOENT error gracefully", async () => {
    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));

    // Try to delete a file that doesn't exist - should return false, not throw
    const result = await deleteMediaFile(uploadsDir, "/uploads/questions/nonexistent-file.jpg");
    expect(result).toBe(false);

    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

});
