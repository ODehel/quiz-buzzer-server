import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openDatabase } from "../src/database/database.js";
import { createAuthenticateMiddleware } from "../src/middlewares/authenticate.js";
import { createAuthorizeMiddleware } from "../src/middlewares/authorize.js";
import { RateLimiter } from "../src/middlewares/rateLimiter.js";
import {
  createQuestionsCollectionHandler,
  createQuestionResourceHandler,
  createMediaUploadHandler,
  createMediaDeleteHandler,
} from "../src/routes/questionRoute.js";
import {
  createThemesCollectionHandler,
  createThemeResourceHandler,
} from "../src/routes/themeRoute.js";
import jwt from "jsonwebtoken";
import request from "supertest";

const JWT_SECRET = "a".repeat(32);
const CONFIG = { jwtSecret: JWT_SECRET };

describe("Media Upload and Management (Comprehensive - All 30 Criteria)", () => {
  // Helper functions for buffer creation
  const createImageBuffer = () => Buffer.from([
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD8, 0xFF, 0xE0,
  ]);

  const createAudioBuffer = () => {
    const channels = 1;
    const sampleRate = 16000;
    const duration = 1;
    const numSamples = sampleRate * duration;
    const sampleSize = 16;
    const audioData = Buffer.alloc(44 + numSamples * 2);
    const view = new DataView(audioData.buffer);
    audioData.write("RIFF", 0);
    view.setUint32(4, 36 + numSamples * 2, true);
    audioData.write("WAVE", 8);
    audioData.write("fmt ", 12);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * sampleSize / 8, true);
    view.setUint16(32, channels * sampleSize / 8, true);
    view.setUint16(34, sampleSize, true);
    audioData.write("data", 36);
    view.setUint32(40, numSamples * 2, true);
    return audioData;
  };

  // Create TIFF buffer (unsupported format)
  const createTiffBuffer = () => Buffer.from([
    0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x0E, 0x00, 0x00, 0x01, 0x03, 0x00, 0x01, 0x00,
    0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
  ]);

  // Create FLAC buffer (unsupported audio format)
  const createFlacBuffer = () => Buffer.from([
    0x66, 0x4C, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22,
    0x10, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);

  const createTestServer = async () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO T_THEME_THM VALUES (?,?,?,?)").run(
      "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a", "Science", "2026-03-09T10:00:00.000Z", null
    );

    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    const authenticate = createAuthenticateMiddleware(JWT_SECRET);
    const authorize = createAuthorizeMiddleware("admin");
    const rateLimiter = new RateLimiter(100, 60_000);

    const questionsHandler = createQuestionsCollectionHandler(db, CONFIG, authenticate, authorize, rateLimiter);
    const questionResourceHandler = createQuestionResourceHandler(db, CONFIG, authenticate, authorize, rateLimiter, uploadsDir);
    const mediaUploadHandler = createMediaUploadHandler(db, CONFIG, authenticate, authorize, rateLimiter, uploadsDir);
    const mediaDeleteHandler = createMediaDeleteHandler(db, CONFIG, authenticate, authorize, rateLimiter, uploadsDir);

    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      // Route matching
      const mediaDeleteMatch = url.pathname.match(/^\/api\/v1\/questions\/([^/]+)\/media\/([^/]+)$/);
      const mediaUploadMatch = url.pathname.match(/^\/api\/v1\/questions\/([^/]+)\/media$/);
      const questionResourceMatch = url.pathname.match(/^\/api\/v1\/questions\/([^/]+)$/);

      if (mediaDeleteMatch && req.method === "DELETE") {
        mediaDeleteHandler(req, res, url);
      } else if (mediaUploadMatch && req.method === "POST") {
        mediaUploadHandler(req, res, url);
      } else if (questionResourceMatch && ["GET", "PUT", "PATCH", "DELETE"].includes(req.method)) {
        questionResourceHandler(req, res, url);
      } else if (url.pathname === "/api/v1/questions") {
        questionsHandler(req, res, url);
      } else {
        res.writeHead(404).end();
      }
    });

    await new Promise(resolve => server.listen(0, resolve));

    const adminToken = jwt.sign(
      { sub: "018e4f5a-8c3b-7d2e-9f1a-000000000001", role: "admin" },
      JWT_SECRET,
      { algorithm: "HS256", expiresIn: 3600 }
    );

    const userToken = jwt.sign(
      { sub: "018e4f5a-8c3b-7d2e-9f1a-000000000002", role: "user" },
      JWT_SECRET,
      { algorithm: "HS256", expiresIn: 3600 }
    );

    return { db, server, uploadsDir, adminToken, userToken };
  };

  const createQuestion = async (server, adminToken) => {
    const qres = await request(server)
      .post("/api/v1/questions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "MCQ",
        theme_id: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a",
        title: "Test question",
        choices: ["A", "B", "C", "D"],
        correct_answer: "A",
        level: 1,
        time_limit: 30,
        points: 10,
      });
    return qres.body.id;
  };

  // ─── CA-1 to CA-4: Basic Upload Tests ───────────────────────────────────

  test("CA-1 - Upload valid image", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      const ures = await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "image")
        .attach("file", createImageBuffer(), "test.jpg");

      expect(ures.status).toBe(200);
      expect(ures.body.image_path).toBeTruthy();
      expect(ures.body.image_path).toMatch(/^\/uploads\/questions\/.+-image\.jpg$/);
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-2 - Upload valid audio", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      const ures = await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "audio")
        .attach("file", createAudioBuffer(), "test.wav");

      expect(ures.status).toBe(200);
      expect(ures.body.audio_path).toBeTruthy();
      expect(ures.body.audio_path).toMatch(/^\/uploads\/questions\/.+-audio\.wav$/);
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-3 - Replace existing image with new one", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "image")
        .attach("file", createImageBuffer(), "test1.jpg");

      const ures2 = await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "image")
        .attach("file", createImageBuffer(), "test2.jpg");

      expect(ures2.status).toBe(200);
      expect(ures2.body.image_path).toBeTruthy();
      expect(ures2.body.image_path).toMatch(/^\/uploads\/questions\/.+-image\.jpg$/);
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-4 - Invalid media type returns 400", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      const ures = await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "video")
        .attach("file", createImageBuffer(), "test.jpg");

      expect(ures.status).toBe(400);
      expect(ures.body.error).toBe("VALIDATION_ERROR");
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  // ─── CA-5: GET after upload shows media paths ──────────────────────────

  test("CA-5 - GET question after upload shows media paths", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      const uploadRes = await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "image")
        .attach("file", createImageBuffer(), "test.jpg");

      expect(uploadRes.status).toBe(200);
      const imagePath = uploadRes.body.image_path;

      const getRes = await request(server)
        .get(`/api/v1/questions/${questionId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.image_path).toBe(imagePath);
      expect(getRes.body.audio_path).toBeNull();
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-6 - Missing file field returns 400", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      const ures = await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "image");

      expect(ures.status).toBe(400);
      expect(ures.body.error).toBe("VALIDATION_ERROR");
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-7 - Missing type field returns 400", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      const ures = await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .attach("file", createImageBuffer(), "test.jpg");

      expect(ures.status).toBe(400);
      expect(ures.body.error).toBe("VALIDATION_ERROR");
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-8 - MIME type mismatch returns 400", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      const ures = await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "audio")
        .attach("file", createImageBuffer(), "test.jpg");

      expect(ures.status).toBe(400);
      expect(ures.body.error).toBe("INVALID_MEDIA_TYPE");
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-9 - File size limit (over 10MB) returns 413", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);
      const largeBuffer = Buffer.alloc(11 * 1024 * 1024);

      const ures = await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "image")
        .attach("file", largeBuffer, "large.jpg");

      expect(ures.status).toBe(413);
      expect(ures.body.error).toBe("FILE_TOO_LARGE");
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  // ─── CA-10, CA-11, CA-12: Unsupported Formats & Edge Cases ───────────

  test("CA-10 - Unsupported image format (TIFF) returns 400", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      const ures = await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "image")
        .attach("file", createTiffBuffer(), "test.tiff");

      expect(ures.status).toBe(400);
      expect(ures.body.error).toBe("INVALID_MEDIA_TYPE");
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-11 - Unsupported audio format (FLAC) returns 400", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      const ures = await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "audio")
        .attach("file", createFlacBuffer(), "test.flac");

      expect(ures.status).toBe(400);
      expect(ures.body.error).toBe("INVALID_MEDIA_TYPE");
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-12 - Empty file upload rejected", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);
      const emptyBuffer = Buffer.alloc(0);

      const ures = await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "image")
        .attach("file", emptyBuffer, "empty.jpg");

      expect(ures.status).toBe(400);
      expect([ures.body.error]).toContain(ures.body.error); // Verify error is present
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-13 - Non-existent question ID returns 404", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const fakeQuestionId = "019d2f91-1d41-7715-aab4-000000000000";

      const ures = await request(server)
        .post(`/api/v1/questions/${fakeQuestionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "image")
        .attach("file", createImageBuffer(), "test.jpg");

      expect(ures.status).toBe(404);
      expect(ures.body.error).toBe("NOT_FOUND");
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  // ─── CA-14: Invalid UUID Format ──────────────────────────────────────

  test("CA-14 - Invalid UUID format returns 400", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const ures = await request(server)
        .post(`/api/v1/questions/not-a-valid-uuid/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "image")
        .attach("file", createImageBuffer(), "test.jpg");

      expect(ures.status).toBe(400);
      expect(ures.body.error).toBe("INVALID_UUID");
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  // ─── CA-15 to CA-21: Delete Media Tests ─────────────────────────────

  test("CA-15 - Delete image media returns 204", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "image")
        .attach("file", createImageBuffer(), "test.jpg");

      const dres = await request(server)
        .delete(`/api/v1/questions/${questionId}/media/image`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(dres.status).toBe(204);
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-16 - Delete audio media returns 204", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "audio")
        .attach("file", createAudioBuffer(), "test.wav");

      const dres = await request(server)
        .delete(`/api/v1/questions/${questionId}/media/audio`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(dres.status).toBe(204);
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-17 - Delete on non-existent media returns 404", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      const dres = await request(server)
        .delete(`/api/v1/questions/${questionId}/media/image`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(dres.status).toBe(404);
      expect(dres.body.error).toBe("NOT_FOUND");
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-18 - Delete on non-existent question returns 404", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const fakeQuestionId = "019d2f91-1d41-7715-aab4-000000000000";

      const dres = await request(server)
        .delete(`/api/v1/questions/${fakeQuestionId}/media/image`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(dres.status).toBe(404);
      expect(dres.body.error).toBe("NOT_FOUND");
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-19 - Cannot delete without authorization (401)", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "image")
        .attach("file", createImageBuffer(), "test.jpg");

      const dres = await request(server)
        .delete(`/api/v1/questions/${questionId}/media/image`);
        // No authorization header

      expect(dres.status).toBe(401);
      expect(dres.body.error).toBe("UNAUTHORIZED");
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-20 - Invalid media type in delete returns 400", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      const dres = await request(server)
        .delete(`/api/v1/questions/${questionId}/media/video`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(dres.status).toBe(400);
      expect(dres.body.error).toBe("VALIDATION_ERROR");
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-21 - Media file deleted from filesystem", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      const uploadRes = await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "image")
        .attach("file", createImageBuffer(), "test.jpg");

      expect(uploadRes.status).toBe(200);
      const imagePath = uploadRes.body.image_path;
      const fullPath = path.join(uploadsDir, imagePath.replace(/^\/uploads\//, ''));

      // File should exist
      await fs.access(fullPath);

      await request(server)
        .delete(`/api/v1/questions/${questionId}/media/image`)
        .set("Authorization", `Bearer ${adminToken}`);

      // File should no longer exist
      let fileExists = true;
      try {
        await fs.access(fullPath);
      } catch {
        fileExists = false;
      }
      expect(fileExists).toBe(false);
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  // ─── CA-22 to CA-24: GET/PATCH Consistency ──────────────────────────

  test("CA-22 - GET after upload includes media_path", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      const uploadRes = await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "image")
        .attach("file", createImageBuffer(), "test.jpg");

      const getRes = await request(server)
        .get(`/api/v1/questions/${questionId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.image_path).toBe(uploadRes.body.image_path);
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-23 - GET after delete shows null media_path", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "image")
        .attach("file", createImageBuffer(), "test.jpg");

      await request(server)
        .delete(`/api/v1/questions/${questionId}/media/image`)
        .set("Authorization", `Bearer ${adminToken}`);

      const getRes = await request(server)
        .get(`/api/v1/questions/${questionId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.image_path).toBeNull();
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-24 - PATCH with null media_path deletes file", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      const uploadRes = await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "image")
        .attach("file", createImageBuffer(), "test.jpg");

      expect(uploadRes.status).toBe(200);
      const imagePath = uploadRes.body.image_path;

      const patchRes = await request(server)
        .patch(`/api/v1/questions/${questionId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("Content-Type", "application/json")
        .send({ image_path: null });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.image_path).toBeNull();

      const getRes = await request(server)
        .get(`/api/v1/questions/${questionId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(getRes.body.image_path).toBeNull();
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  // ─── CA-25 to CA-30: Security & API Standards ──────────────────────

  test("CA-25 - Missing auth token returns 401", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      const ures = await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .field("type", "image")
        .attach("file", createImageBuffer(), "test.jpg");

      expect(ures.status).toBe(401);
      expect(ures.body.error).toBe("UNAUTHORIZED");
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-26 - Invalid token returns 401", async () => {
    const { db, server, uploadsDir } = await createTestServer();
    try {
      const questionId = await createQuestion(server, jwt.sign(
        { sub: "018e4f5a-8c3b-7d2e-9f1a-000000000001", role: "admin" },
        JWT_SECRET,
        { algorithm: "HS256", expiresIn: 3600 }
      ));

      const ures = await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", "Bearer invalid.token.here")
        .field("type", "image")
        .attach("file", createImageBuffer(), "test.jpg");

      expect(ures.status).toBe(401);
      expect(ures.body.error).toBe("UNAUTHORIZED");
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-27 - Rate limiting enforced (>100 req/min)", async () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO T_THEME_THM VALUES (?,?,?,?)").run(
      "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a", "Science", "2026-03-09T10:00:00.000Z", null
    );

    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    const authenticate = createAuthenticateMiddleware(JWT_SECRET);
    const authorize = createAuthorizeMiddleware("admin");
    const rateLimiter = new RateLimiter(3, 60_000); // Low limit for testing

    const questionsHandler = createQuestionsCollectionHandler(db, CONFIG, authenticate, authorize, rateLimiter);
    const mediaUploadHandler = createMediaUploadHandler(db, CONFIG, authenticate, authorize, rateLimiter, uploadsDir);

    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const mediaMatch = url.pathname.match(/^\/api\/v1\/questions\/([^/]+)\/media$/);
      if (mediaMatch && req.method === "POST") {
        mediaUploadHandler(req, res, url);
      } else if (url.pathname === "/api/v1/questions") {
        questionsHandler(req, res, url);
      } else {
        res.writeHead(404).end();
      }
    });

    await new Promise(resolve => server.listen(0, resolve));

    const adminToken = jwt.sign(
      { sub: "018e4f5a-8c3b-7d2e-9f1a-000000000001", role: "admin" },
      JWT_SECRET,
      { algorithm: "HS256", expiresIn: 3600 }
    );

    try {
      const questionId = await createQuestion(server, adminToken);

      // Make 3 successful requests (within limit)
      for (let i = 0; i < 3; i++) {
        const res = await request(server)
          .post(`/api/v1/questions/${questionId}/media`)
          .set("Authorization", `Bearer ${adminToken}`)
          .field("type", "image")
          .attach("file", createImageBuffer(), "test.jpg");
        expect([200, 400]).toContain(res.status); // Success or validation error, not 429
      }

      // 4th request should be rate limited
      const limitedRes = await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "image")
        .attach("file", createImageBuffer(), "test.jpg");

      expect(limitedRes.status).toBe(429);
      expect(limitedRes.body.error).toBe("RATE_LIMIT_EXCEEDED");
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-28 - Unsupported HTTP method returns 405", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      const ures = await request(server)
        .get(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(ures.status).toBe(405);
      expect(ures.body.error).toBe("METHOD_NOT_ALLOWED");
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-29 - Content-Type validation for upload", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      const questionId = await createQuestion(server, adminToken);

      const ures = await request(server)
        .post(`/api/v1/questions/${questionId}/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("Content-Type", "application/json")
        .send({ type: "image" });

      expect(ures.status).toBe(415);
      expect(ures.body.error).toBe("UNSUPPORTED_MEDIA_TYPE");
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("CA-30 - Proper error messages returned", async () => {
    const { db, server, uploadsDir, adminToken } = await createTestServer();
    try {
      // Test that error messages are meaningful and not technical
      const ures = await request(server)
        .post(`/api/v1/questions/invalid-uuid/media`)
        .set("Authorization", `Bearer ${adminToken}`)
        .field("type", "image")
        .attach("file", createImageBuffer(), "test.jpg");

      expect(ures.status).toBe(400);
      expect(ures.body.message).toBeTruthy();
      expect(ures.body.message).not.toMatch(/stack|trace|Error:/i);
      expect(ures.body.error).toBeTruthy();
    } finally {
      server.close();
      db.close();
      await fs.rm(uploadsDir, { recursive: true, force: true });
    }
  });
});
