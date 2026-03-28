import { createServer } from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase } from "../../src/database/database.js";
import { createAuthenticateMiddleware } from "../../src/middlewares/authenticate.js";
import { createAuthorizeMiddleware } from "../../src/middlewares/authorize.js";
import { RateLimiter } from "../../src/middlewares/rateLimiter.js";
import {
  createSoundsCollectionHandler,
  createSoundResourceHandler,
} from "../../src/routes/soundRoute.js";
import jwt from "jsonwebtoken";
import request from "supertest";

const JWT_SECRET = "a".repeat(32);
const CONFIG = { jwtSecret: JWT_SECRET };

function createAdminToken() {
  return jwt.sign({ sub: "admin-uuid", role: "admin" }, JWT_SECRET, { expiresIn: 3600 });
}

function createBuzzerToken() {
  return jwt.sign({ sub: "buzzer-uuid", role: "buzzer" }, JWT_SECRET, { expiresIn: 3600 });
}

function createAudioBuffer() {
  // Minimal WAV header
  const channels = 1;
  const sampleRate = 16000;
  const numSamples = 100;
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
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  audioData.write("data", 36);
  view.setUint32(40, numSamples * 2, true);
  return audioData;
}

describe("Sound REST API (Integration)", () => {
  let db;
  let uploadsDir;
  let server;
  let adminToken;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-sounds-"));
    adminToken = createAdminToken();

    const authenticate = createAuthenticateMiddleware(JWT_SECRET);
    const authorize = createAuthorizeMiddleware("admin");
    const rateLimiter = new RateLimiter(100, 60_000);

    const soundsCollectionHandler = createSoundsCollectionHandler(db, CONFIG, authenticate, authorize, rateLimiter, uploadsDir);
    const soundResourceHandler = createSoundResourceHandler(db, CONFIG, authenticate, authorize, rateLimiter, uploadsDir);

    server = createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      // Static file serving for sounds
      const soundFileMatch = url.pathname.match(/^\/uploads\/sounds\/([^/]+)$/);
      if (soundFileMatch && req.method === "GET") {
        const filename = soundFileMatch[1];
        const filePath = path.join(uploadsDir, "sounds", filename);
        const mimeMap = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg" };
        const ext = path.extname(filename).toLowerCase();
        const mime = mimeMap[ext];
        if (!mime) { res.writeHead(404).end(); return; }
        try {
          const stat = fsSync.statSync(filePath);
          res.writeHead(200, { "Content-Type": mime, "Content-Length": stat.size });
          fsSync.createReadStream(filePath).pipe(res);
        } catch { res.writeHead(404).end(); }
        return;
      }

      if (url.pathname === "/api/v1/sounds") {
        soundsCollectionHandler(req, res, url);
      } else if (url.pathname.match(/^\/api\/v1\/sounds\/[^/]+$/)) {
        soundResourceHandler(req, res, url);
      } else {
        res.writeHead(404).end();
      }
    });
  });

  afterEach(async () => {
    db.close();
    await fs.rm(uploadsDir, { recursive: true, force: true });
    server.close();
  });

  // ── POST /api/v1/sounds ────────────────────────────────────────────────

  describe("POST /api/v1/sounds", () => {
    test("CA-1 — upload valid mp3 → 201 with resource", async () => {
      const res = await request(server)
        .post("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`)
        .field("name", "Générique intro")
        .attach("file", createAudioBuffer(), { filename: "jingle.wav", contentType: "audio/wav" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        id: expect.any(String),
        name: "Générique intro",
        filename: expect.any(String),
        url: expect.stringMatching(/^\/uploads\/sounds\//),
        created_at: expect.any(String),
      });
    });

    test("CA-3 — name is normalized", async () => {
      const res = await request(server)
        .post("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`)
        .field("name", "  Générique   intro  ")
        .attach("file", createAudioBuffer(), { filename: "jingle.wav", contentType: "audio/wav" });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe("Générique intro");
    });

    test("CA-4 — empty name → 400 VALIDATION_ERROR", async () => {
      const res = await request(server)
        .post("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`)
        .field("name", "   ")
        .attach("file", createAudioBuffer(), { filename: "jingle.wav", contentType: "audio/wav" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("VALIDATION_ERROR");
    });

    test("CA-4 — name over 100 chars → 400 VALIDATION_ERROR", async () => {
      const res = await request(server)
        .post("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`)
        .field("name", "A".repeat(101))
        .attach("file", createAudioBuffer(), { filename: "jingle.wav", contentType: "audio/wav" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("VALIDATION_ERROR");
    });

    test("CA-5 — file field absent → 400 VALIDATION_ERROR", async () => {
      const res = await request(server)
        .post("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("Content-Type", "multipart/form-data; boundary=----FormBoundary")
        .field("name", "Générique intro");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("VALIDATION_ERROR");
    });

    test("CA-6 — name field absent → 400 VALIDATION_ERROR", async () => {
      const res = await request(server)
        .post("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`)
        .attach("file", createAudioBuffer(), { filename: "jingle.wav", contentType: "audio/wav" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("VALIDATION_ERROR");
    });

    test("CA-7 — invalid MIME type → 400 INVALID_MEDIA_TYPE", async () => {
      const res = await request(server)
        .post("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`)
        .field("name", "Bad format")
        .attach("file", Buffer.from("fake image"), { filename: "image.jpg", contentType: "image/jpeg" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_MEDIA_TYPE");
    });

    test("CA-8 — file exceeds 10MB → 413 FILE_TOO_LARGE", async () => {
      const bigBuffer = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
      const res = await request(server)
        .post("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`)
        .field("name", "Big file")
        .attach("file", bigBuffer, { filename: "big.wav", contentType: "audio/wav" });

      expect(res.status).toBe(413);
      expect(res.body.error).toBe("FILE_TOO_LARGE");
    });

    test("CA-9 — duplicate name → 409 SOUND_ALREADY_EXISTS", async () => {
      await request(server)
        .post("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`)
        .field("name", "Duplicate")
        .attach("file", createAudioBuffer(), { filename: "j.wav", contentType: "audio/wav" });

      const res = await request(server)
        .post("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`)
        .field("name", "duplicate")
        .attach("file", createAudioBuffer(), { filename: "j2.wav", contentType: "audio/wav" });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("SOUND_ALREADY_EXISTS");
    });

    test("CA-10 — non multipart/form-data → 415 UNSUPPORTED_MEDIA_TYPE", async () => {
      const res = await request(server)
        .post("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("Content-Type", "application/json")
        .send({ name: "Test" });

      expect(res.status).toBe(415);
      expect(res.body.error).toBe("UNSUPPORTED_MEDIA_TYPE");
    });

    test("CA-31 — missing bearer token → 401 UNAUTHORIZED", async () => {
      const res = await request(server)
        .post("/api/v1/sounds")
        .field("name", "No auth")
        .attach("file", createAudioBuffer(), { filename: "j.wav", contentType: "audio/wav" });

      expect(res.status).toBe(401);
    });

    test("CA-32 — buzzer role → 403 FORBIDDEN", async () => {
      const res = await request(server)
        .post("/api/v1/sounds")
        .set("Authorization", `Bearer ${createBuzzerToken()}`)
        .field("name", "Buzzer upload")
        .attach("file", createAudioBuffer(), { filename: "j.wav", contentType: "audio/wav" });

      expect(res.status).toBe(403);
    });

    test("CA-34 — unsupported HTTP method → 405 METHOD_NOT_ALLOWED", async () => {
      const res = await request(server)
        .put("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(405);
      expect(res.body.error).toBe("METHOD_NOT_ALLOWED");
      expect(res.headers.allow).toBe("GET, POST");
    });
  });

  // ── GET /api/v1/sounds ─────────────────────────────────────────────────

  describe("GET /api/v1/sounds", () => {
    test("CA-11 — returns paginated list", async () => {
      await request(server)
        .post("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`)
        .field("name", "Sound A")
        .attach("file", createAudioBuffer(), { filename: "a.wav", contentType: "audio/wav" });

      const res = await request(server)
        .get("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
      expect(res.body.page).toBe(1);
      expect(res.body.limit).toBe(20);
      expect(res.body.total_pages).toBe(1);
    });

    test("CA-12 — default pagination", async () => {
      const res = await request(server)
        .get("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
      expect(res.body.limit).toBe(20);
    });

    test("CA-13 — invalid pagination (page=0) → 400 INVALID_PAGINATION", async () => {
      const res = await request(server)
        .get("/api/v1/sounds?page=0")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_PAGINATION");
    });

    test("CA-13 — invalid pagination (limit > 100) → 400 INVALID_PAGINATION", async () => {
      const res = await request(server)
        .get("/api/v1/sounds?limit=101")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_PAGINATION");
    });

    test("CA-13 — invalid pagination (negative page) → 400 INVALID_PAGINATION", async () => {
      const res = await request(server)
        .get("/api/v1/sounds?page=-1")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_PAGINATION");
    });

    test("CA-13 — invalid pagination (non-numeric) → 400 INVALID_PAGINATION", async () => {
      const res = await request(server)
        .get("/api/v1/sounds?page=abc")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_PAGINATION");
    });

    test("CA-14 — no sounds → 200 with empty data and total 0", async () => {
      const res = await request(server)
        .get("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ data: [], total: 0 });
    });
  });

  // ── GET /api/v1/sounds/:id ─────────────────────────────────────────────

  describe("GET /api/v1/sounds/:id", () => {
    test("CA-15 — returns sound by ID", async () => {
      const created = await request(server)
        .post("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`)
        .field("name", "My Sound")
        .attach("file", createAudioBuffer(), { filename: "s.wav", contentType: "audio/wav" });

      const res = await request(server)
        .get(`/api/v1/sounds/${created.body.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: created.body.id,
        name: "My Sound",
        filename: expect.any(String),
        url: expect.any(String),
        created_at: expect.any(String),
      });
    });

    test("CA-16 — non-existent ID → 404 NOT_FOUND", async () => {
      const res = await request(server)
        .get("/api/v1/sounds/018e4f5a-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("NOT_FOUND");
    });

    test("CA-17 — malformed ID → 400 INVALID_UUID", async () => {
      const res = await request(server)
        .get("/api/v1/sounds/bad-id")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_UUID");
    });

    test("CA-34 — unsupported method on resource → 405", async () => {
      const res = await request(server)
        .put("/api/v1/sounds/018e4f5a-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(405);
      expect(res.body.error).toBe("METHOD_NOT_ALLOWED");
      expect(res.headers.allow).toBe("GET, DELETE");
    });
  });

  // ── DELETE /api/v1/sounds/:id ──────────────────────────────────────────

  describe("DELETE /api/v1/sounds/:id", () => {
    test("CA-18 — deletes sound → 204 No Content", async () => {
      const created = await request(server)
        .post("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`)
        .field("name", "To delete")
        .attach("file", createAudioBuffer(), { filename: "d.wav", contentType: "audio/wav" });

      const res = await request(server)
        .delete(`/api/v1/sounds/${created.body.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(204);

      // Verify it's gone
      const check = await request(server)
        .get(`/api/v1/sounds/${created.body.id}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(check.status).toBe(404);
    });

    test("CA-19 — non-existent ID → 404 NOT_FOUND", async () => {
      const res = await request(server)
        .delete("/api/v1/sounds/018e4f5a-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("NOT_FOUND");
    });

    test("CA-20 — malformed ID → 400 INVALID_UUID", async () => {
      const res = await request(server)
        .delete("/api/v1/sounds/bad-id")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_UUID");
    });

    test("CA-21 — file missing on disk → 204 (tolerant)", async () => {
      const created = await request(server)
        .post("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`)
        .field("name", "Missing file test")
        .attach("file", createAudioBuffer(), { filename: "m.wav", contentType: "audio/wav" });

      // Manually delete file
      const soundsPath = path.join(uploadsDir, "sounds");
      const files = await fs.readdir(soundsPath);
      for (const f of files) {
        await fs.unlink(path.join(soundsPath, f));
      }

      const res = await request(server)
        .delete(`/api/v1/sounds/${created.body.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(204);
    });
  });

  // ── Rate limiting (CA-33) ──────────────────────────────────────────────

  describe("Rate limiting", () => {
    test("CA-33 — exceeds rate limit → 429", async () => {
      const rateLimiter = new RateLimiter(1, 60_000);
      const authenticate = createAuthenticateMiddleware(JWT_SECRET);
      const authorize = createAuthorizeMiddleware("admin");
      const handler = createSoundsCollectionHandler(db, CONFIG, authenticate, authorize, rateLimiter, uploadsDir);

      const limitedServer = createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        handler(req, res, url);
      });

      // First request passes
      await request(limitedServer)
        .get("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`);

      // Second request → 429
      const res = await request(limitedServer)
        .get("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(429);
      expect(res.body.error).toBe("RATE_LIMIT_EXCEEDED");
      expect(res.headers["retry-after"]).toBeDefined();

      limitedServer.close();
    });
  });

  // ── Static file serving (CA-29) ────────────────────────────────────────

  describe("Static file serving", () => {
    test("CA-29 — uploaded sound is accessible via HTTP GET", async () => {
      const created = await request(server)
        .post("/api/v1/sounds")
        .set("Authorization", `Bearer ${adminToken}`)
        .field("name", "Downloadable")
        .attach("file", createAudioBuffer(), { filename: "dl.wav", contentType: "audio/wav" });

      const res = await request(server).get(created.body.url);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("audio/wav");
    });
  });
});
