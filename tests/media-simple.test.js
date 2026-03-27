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

describe("Media Upload and Management (Simplified)", () => {
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

  test("CA-1 - Upload valid image", async () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO T_THEME_THM VALUES (?,?,?,?)").run(
      "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a", "Science", "2026-03-09T10:00:00.000Z", null
    );

    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    const authenticate = createAuthenticateMiddleware(JWT_SECRET);
    const authorize = createAuthorizeMiddleware("admin");
    const rateLimiter = new RateLimiter(100, 60_000);

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

    const qres = await request(server)
      .post("/api/v1/questions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "MCQ",
        theme_id: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a",
        title: "Simple upload test",
        choices: ["A", "B", "C", "D"],
        correct_answer: "A",
        level: 1,
        time_limit: 30,
        points: 10,
      });

    const questionId = qres.body.id;

    const ures = await request(server)
      .post(`/api/v1/questions/${questionId}/media`)
      .set("Authorization", `Bearer ${adminToken}`)
      .field("type", "image")
      .attach("file", createImageBuffer(), "test.jpg");

    expect(ures.status).toBe(200);
    expect(ures.body.image_path).toBeTruthy();
    expect(ures.body.image_path).toMatch(/^\/uploads\/questions\/.+-image\.jpg$/);

    server.close();
    db.close();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  test("CA-2 - Upload valid audio", async () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO T_THEME_THM VALUES (?,?,?,?)").run(
      "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a", "Science", "2026-03-09T10:00:00.000Z", null
    );

    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    const authenticate = createAuthenticateMiddleware(JWT_SECRET);
    const authorize = createAuthorizeMiddleware("admin");
    const rateLimiter = new RateLimiter(100, 60_000);

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

    const qres = await request(server)
      .post("/api/v1/questions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "MCQ",
        theme_id: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a",
        title: "Simple audio upload test",
        choices: ["A", "B", "C", "D"],
        correct_answer: "A",
        level: 1,
        time_limit: 30,
        points: 10,
      });

    const questionId = qres.body.id;

    const ures = await request(server)
      .post(`/api/v1/questions/${questionId}/media`)
      .set("Authorization", `Bearer ${adminToken}`)
      .field("type", "audio")
      .attach("file", createAudioBuffer(), "test.wav");

    expect(ures.status).toBe(200);
    expect(ures.body.audio_path).toBeTruthy();
    expect(ures.body.audio_path).toMatch(/^\/uploads\/questions\/.+-audio\.wav$/);

    server.close();
    db.close();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  test("CA-3 - Replace existing image with new one", async () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO T_THEME_THM VALUES (?,?,?,?)").run(
      "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a", "Science", "2026-03-09T10:00:00.000Z", null
    );

    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    const authenticate = createAuthenticateMiddleware(JWT_SECRET);
    const authorize = createAuthorizeMiddleware("admin");
    const rateLimiter = new RateLimiter(100, 60_000);

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

    const qres = await request(server)
      .post("/api/v1/questions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "MCQ",
        theme_id: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a",
        title: "Replace test",
        choices: ["A", "B", "C", "D"],
        correct_answer: "A",
        level: 1,
        time_limit: 30,
        points: 10,
      });

    const questionId = qres.body.id;

    // Upload first image
    await request(server)
      .post(`/api/v1/questions/${questionId}/media`)
      .set("Authorization", `Bearer ${adminToken}`)
      .field("type", "image")
      .attach("file", createImageBuffer(), "test1.jpg");

    // Replace with second image
    const ures2 = await request(server)
      .post(`/api/v1/questions/${questionId}/media`)
      .set("Authorization", `Bearer ${adminToken}`)
      .field("type", "image")
      .attach("file", createImageBuffer(), "test2.jpg");

    expect(ures2.status).toBe(200);
    expect(ures2.body.image_path).toBeTruthy();
    expect(ures2.body.image_path).toMatch(/^\/uploads\/questions\/.+-image\.jpg$/);

    server.close();
    db.close();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  test("CA-6 - Missing file field returns 400", async () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO T_THEME_THM VALUES (?,?,?,?)").run(
      "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a", "Science", "2026-03-09T10:00:00.000Z", null
    );

    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    const authenticate = createAuthenticateMiddleware(JWT_SECRET);
    const authorize = createAuthorizeMiddleware("admin");
    const rateLimiter = new RateLimiter(100, 60_000);

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

    const qres = await request(server)
      .post("/api/v1/questions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "MCQ",
        theme_id: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a",
        title: "No file test",
        choices: ["A", "B", "C", "D"],
        correct_answer: "A",
        level: 1,
        time_limit: 30,
        points: 10,
      });

    const questionId = qres.body.id;

    // Upload without file field
    const ures = await request(server)
      .post(`/api/v1/questions/${questionId}/media`)
      .set("Authorization", `Bearer ${adminToken}`)
      .field("type", "image");

    expect(ures.status).toBe(400);
    expect(ures.body.error).toBe("VALIDATION_ERROR");

    server.close();
    db.close();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  test("CA-7 - Missing type field returns 400", async () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO T_THEME_THM VALUES (?,?,?,?)").run(
      "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a", "Science", "2026-03-09T10:00:00.000Z", null
    );

    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    const authenticate = createAuthenticateMiddleware(JWT_SECRET);
    const authorize = createAuthorizeMiddleware("admin");
    const rateLimiter = new RateLimiter(100, 60_000);

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

    const qres = await request(server)
      .post("/api/v1/questions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "MCQ",
        theme_id: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a",
        title: "No type test",
        choices: ["A", "B", "C", "D"],
        correct_answer: "A",
        level: 1,
        time_limit: 30,
        points: 10,
      });

    const questionId = qres.body.id;

    // Upload without type field
    const ures = await request(server)
      .post(`/api/v1/questions/${questionId}/media`)
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", createImageBuffer(), "test.jpg");

    expect(ures.status).toBe(400);
    expect(ures.body.error).toBe("VALIDATION_ERROR");

    server.close();
    db.close();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  test("CA-4 - Invalid media type returns 400", async () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO T_THEME_THM VALUES (?,?,?,?)").run(
      "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a", "Science", "2026-03-09T10:00:00.000Z", null
    );

    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    const authenticate = createAuthenticateMiddleware(JWT_SECRET);
    const authorize = createAuthorizeMiddleware("admin");
    const rateLimiter = new RateLimiter(100, 60_000);

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

    const qres = await request(server)
      .post("/api/v1/questions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "MCQ",
        theme_id: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a",
        title: "Invalid type test",
        choices: ["A", "B", "C", "D"],
        correct_answer: "A",
        level: 1,
        time_limit: 30,
        points: 10,
      });

    const questionId = qres.body.id;

    // Upload with invalid type
    const ures = await request(server)
      .post(`/api/v1/questions/${questionId}/media`)
      .set("Authorization", `Bearer ${adminToken}`)
      .field("type", "video")
      .attach("file", createImageBuffer(), "test.jpg");

    expect(ures.status).toBe(400);
    expect(ures.body.error).toBe("VALIDATION_ERROR");

    server.close();
    db.close();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  test("CA-8 - MIME type mismatch returns 400", async () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO T_THEME_THM VALUES (?,?,?,?)").run(
      "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a", "Science", "2026-03-09T10:00:00.000Z", null
    );

    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    const authenticate = createAuthenticateMiddleware(JWT_SECRET);
    const authorize = createAuthorizeMiddleware("admin");
    const rateLimiter = new RateLimiter(100, 60_000);

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

    const qres = await request(server)
      .post("/api/v1/questions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "MCQ",
        theme_id: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a",
        title: "MIME mismatch test",
        choices: ["A", "B", "C", "D"],
        correct_answer: "A",
        level: 1,
        time_limit: 30,
        points: 10,
      });

    const questionId = qres.body.id;

    // Upload image buffer but declare as audio
    const ures = await request(server)
      .post(`/api/v1/questions/${questionId}/media`)
      .set("Authorization", `Bearer ${adminToken}`)
      .field("type", "audio")
      .attach("file", createImageBuffer(), "test.jpg");

    expect(ures.status).toBe(400);
    expect(ures.body.error).toBe("INVALID_MEDIA_TYPE");

    server.close();
    db.close();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  test("CA-13 - Non-existent question ID returns 404", async () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO T_THEME_THM VALUES (?,?,?,?)").run(
      "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a", "Science", "2026-03-09T10:00:00.000Z", null
    );

    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    const authenticate = createAuthenticateMiddleware(JWT_SECRET);
    const authorize = createAuthorizeMiddleware("admin");
    const rateLimiter = new RateLimiter(100, 60_000);

    const mediaUploadHandler = createMediaUploadHandler(db, CONFIG, authenticate, authorize, rateLimiter, uploadsDir);

    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const mediaMatch = url.pathname.match(/^\/api\/v1\/questions\/([^/]+)\/media$/);
      if (mediaMatch && req.method === "POST") {
        mediaUploadHandler(req, res, url);
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

    const fakeQuestionId = "019d2f91-1d41-7715-aab4-000000000000";

    // Upload to non-existent question
    const ures = await request(server)
      .post(`/api/v1/questions/${fakeQuestionId}/media`)
      .set("Authorization", `Bearer ${adminToken}`)
      .field("type", "image")
      .attach("file", createImageBuffer(), "test.jpg");

    expect(ures.status).toBe(404);
    expect(ures.body.error).toBe("NOT_FOUND");

    server.close();
    db.close();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

});
