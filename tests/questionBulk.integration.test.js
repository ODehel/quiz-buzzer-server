import { createServer } from "node:http";
import { openDatabase } from "../src/database/database.js";
import { createAuthenticateMiddleware } from "../src/middlewares/authenticate.js";
import { createAuthorizeMiddleware } from "../src/middlewares/authorize.js";
import { RateLimiter } from "../src/middlewares/rateLimiter.js";
import {
  createQuestionsBulkHandler,
} from "../src/routes/questionRoute.js";
import jwt from "jsonwebtoken";
import request from "supertest";

const JWT_SECRET = "a".repeat(32);
const config = { jwtSecret: JWT_SECRET, jwtExpiration: 3600 };

let db, server, adminToken;
let themeId;

function makeToken(role = "admin") {
  return jwt.sign(
    { sub: "018e4f5a-8c3b-7d2e-9f1a-000000000001", role },
    JWT_SECRET,
    { algorithm: "HS256", expiresIn: 3600 }
  );
}

beforeEach((done) => {
  db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO T_THEME_THM (THM_ID, THM_NAME, THM_CREATED_AT) VALUES (?, ?, ?)"
  ).run("018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a", "Science", "2026-03-09T10:00:00.000Z");
  themeId = "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a";

  const authenticate = createAuthenticateMiddleware(JWT_SECRET);
  const authorize = createAuthorizeMiddleware("admin");
  const rateLimiter = new RateLimiter(100, 60_000);

  const bulkHandler = createQuestionsBulkHandler(db, config, authenticate, authorize, rateLimiter);

  adminToken = makeToken("admin");

  server = createServer((req, res) => {
    if (req.url === "/api/v1/questions/bulk") {
      bulkHandler(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, done);
});

afterEach((done) => {
  db.close();
  server.close(done);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mcqQuestion(overrides = {}) {
  return {
    type: "MCQ",
    theme_id: themeId,
    title: "Quelle est la capitale de la France ?",
    choices: ["Paris", "Lyon", "Marseille", "Toulouse"],
    correct_answer: "Paris",
    level: 1,
    time_limit: 30,
    points: 10,
    ...overrides,
  };
}

function speedQuestion(overrides = {}) {
  return {
    type: "SPEED",
    theme_id: themeId,
    title: "Quel est le plus grand océan du monde ?",
    correct_answer: "Pacifique",
    level: 2,
    time_limit: 15,
    points: 20,
    ...overrides,
  };
}

async function postBulk(questions, token = adminToken) {
  return request(server)
    .post("/api/v1/questions/bulk")
    .set("Authorization", token ? `Bearer ${token}` : "")
    .set("Content-Type", "application/json")
    .send({ questions });
}

// ─── POST /api/v1/questions/bulk ─────────────────────────────────────────────

describe("POST /api/v1/questions/bulk", () => {
  // ── Success ────────────────────────────────────────────────────────────────

  test("inserts two MCQ questions and returns 201", async () => {
    const res = await postBulk([
      mcqQuestion({ title: "Quelle est la capitale de la France ?" }),
      mcqQuestion({ title: "Quelle est la capitale de l'Allemagne ?", correct_answer: "Lyon", choices: ["Lyon", "Berlin", "Madrid", "Rome"] }),
    ]);
    expect(res.status).toBe(201);
    expect(res.body.created_count).toBe(2);
    expect(res.body.questions).toHaveLength(2);
    expect(res.body.questions[0].type).toBe("MCQ");
    expect(res.body.questions[1].type).toBe("MCQ");
  });

  test("inserts one MCQ and one SPEED question", async () => {
    const res = await postBulk([
      mcqQuestion(),
      speedQuestion(),
    ]);
    expect(res.status).toBe(201);
    expect(res.body.created_count).toBe(2);
    expect(res.body.questions[0].type).toBe("MCQ");
    expect(res.body.questions[0].choices).toHaveLength(4);
    expect(res.body.questions[1].type).toBe("SPEED");
    expect(res.body.questions[1]).not.toHaveProperty("choices");
  });

  test("returns correct API format for each question", async () => {
    const res = await postBulk([mcqQuestion()]);
    const q = res.body.questions[0];
    expect(q.id).toBeTruthy();
    expect(q.created_at).toBeTruthy();
    expect(q.last_updated_at).toBeNull();
    expect(q.image_path).toBeNull();
    expect(q.audio_path).toBeNull();
    expect(q.title).toBe("Quelle est la capitale de la France ?");
    expect(q.correct_answer).toBe("Paris");
    expect(q.level).toBe(1);
    expect(q.time_limit).toBe(30);
    expect(q.points).toBe(10);
    expect(q.theme_id).toBe(themeId);
  });

  // ── Body validation ────────────────────────────────────────────────────────

  test("400 when body is not a JSON object", async () => {
    const res = await request(server)
      .post("/api/v1/questions/bulk")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify([mcqQuestion()]));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  test("400 when 'questions' key is missing", async () => {
    const res = await request(server)
      .post("/api/v1/questions/bulk")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  test("400 when 'questions' is not an array", async () => {
    const res = await request(server)
      .post("/api/v1/questions/bulk")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ questions: "not-an-array" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  test("400 when 'questions' array is empty", async () => {
    const res = await postBulk([]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  test("400 when 'questions' exceeds 50 elements", async () => {
    const questions = Array.from({ length: 51 }, (_, i) =>
      mcqQuestion({ title: `Question numéro ${String(i + 1).padStart(3, "0")} pour le test en lot` })
    );
    const res = await postBulk(questions);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  // ── Per-question validation ────────────────────────────────────────────────

  test("400 with [index N] when a question has an invalid type", async () => {
    const res = await postBulk([
      mcqQuestion(),
      mcqQuestion({ title: "Seconde question dans le lot ici ?", type: "INVALID" }),
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
    expect(res.body.message).toContain("[index 1]");
  });

  test("400 with [index N] when a question title is too short", async () => {
    const res = await postBulk([
      mcqQuestion({ title: "Court" }),
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
    expect(res.body.message).toContain("[index 0]");
  });

  test("400 with [index N] for unknown fields", async () => {
    const res = await postBulk([
      { ...mcqQuestion(), unknown_field: "value" },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("UNKNOWN_FIELDS");
    expect(res.body.message).toContain("[index 0]");
  });

  test("400 with [index N] when theme_id is invalid UUID", async () => {
    const res = await postBulk([
      mcqQuestion({ theme_id: "not-a-uuid" }),
    ]);
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("[index 0]");
  });

  test("400 INVALID_THEME with [index N] when theme_id does not exist", async () => {
    const res = await postBulk([
      mcqQuestion({ theme_id: "018e4f5a-0000-0000-0000-000000000000" }),
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_THEME");
    expect(res.body.message).toContain("[index 0]");
  });

  // ── Atomicity ──────────────────────────────────────────────────────────────

  test("atomicity: no question inserted when one fails validation", async () => {
    const res = await postBulk([
      mcqQuestion({ title: "Quelle est la capitale de la France ?" }),
      mcqQuestion({ title: "Short" }), // invalid title
    ]);
    expect(res.status).toBe(400);

    // Verify DB is empty
    const count = db.prepare("SELECT COUNT(*) AS c FROM T_QUESTION_QST").get().c;
    expect(count).toBe(0);
  });

  // ── Duplicate detection ────────────────────────────────────────────────────

  test("409 QUESTION_ALREADY_EXISTS when two questions in the batch share a title", async () => {
    const res = await postBulk([
      mcqQuestion({ title: "Quelle est la capitale de la France ?" }),
      speedQuestion({ title: "Quelle est la capitale de la France ?" }),
    ]);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("QUESTION_ALREADY_EXISTS");
    expect(res.body.message).toContain("[index 1]");
  });

  test("409 QUESTION_ALREADY_EXISTS when title already exists in DB", async () => {
    // Insert a question first
    db.prepare(
      `INSERT INTO T_QUESTION_QST (QST_ID, QST_TYPE, QST_THEME_ID, QST_TITLE,
         QST_CORRECT_ANSWER, QST_LEVEL, QST_TIME_LIMIT, QST_POINTS, QST_CREATED_AT)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "018e4f5a-8c3b-7d2e-9f1a-000000000099",
      "SPEED", themeId,
      "Quelle est la capitale de la France ?",
      "Paris", 1, 30, 10,
      "2026-03-09T10:00:00.000Z"
    );

    const res = await postBulk([
      mcqQuestion({ title: "Quelle est la capitale de la France ?" }),
    ]);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("QUESTION_ALREADY_EXISTS");
    expect(res.body.message).toContain("[index 0]");
  });

  // ── Auth / Authorization ───────────────────────────────────────────────────

  test("401 when no token is provided", async () => {
    const res = await request(server)
      .post("/api/v1/questions/bulk")
      .set("Content-Type", "application/json")
      .send({ questions: [mcqQuestion()] });
    expect(res.status).toBe(401);
  });

  test("403 when user is not admin", async () => {
    const userToken = makeToken("user");
    const res = await postBulk([mcqQuestion()], userToken);
    expect(res.status).toBe(403);
  });

  // ── Content-Type ───────────────────────────────────────────────────────────

  test("415 when Content-Type is not application/json", async () => {
    const res = await request(server)
      .post("/api/v1/questions/bulk")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "text/plain")
      .send("some text");
    expect(res.status).toBe(415);
  });

  // ── Method not allowed ─────────────────────────────────────────────────────

  test("405 for GET method", async () => {
    const res = await request(server)
      .get("/api/v1/questions/bulk")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(405);
    expect(res.body.error).toBe("METHOD_NOT_ALLOWED");
    expect(res.headers.allow).toBe("POST");
  });

  test("405 for PUT method", async () => {
    const res = await request(server)
      .put("/api/v1/questions/bulk")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({});
    expect(res.status).toBe(405);
    expect(res.body.error).toBe("METHOD_NOT_ALLOWED");
  });

  test("405 for DELETE method", async () => {
    const res = await request(server)
      .delete("/api/v1/questions/bulk")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(405);
    expect(res.body.error).toBe("METHOD_NOT_ALLOWED");
  });

  // ── Rate limiting ──────────────────────────────────────────────────────────

  test("429 when rate limit is exceeded", async () => {
    const tinyRateLimiter = new RateLimiter(1, 60_000);
    const authenticate = createAuthenticateMiddleware(JWT_SECRET);
    const authorize = createAuthorizeMiddleware("admin");
    const bulkHandler = createQuestionsBulkHandler(db, config, authenticate, authorize, tinyRateLimiter);

    const tempServer = createServer((req, res) => {
      bulkHandler(req, res);
    });

    await new Promise((resolve) => tempServer.listen(0, resolve));
    try {
      // First request (GET triggers rate check before method check — still counts)
      await request(tempServer)
        .get("/api/v1/questions/bulk")
        .set("Authorization", `Bearer ${adminToken}`);
      // Second request should be rate-limited
      const res = await request(tempServer)
        .get("/api/v1/questions/bulk")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(429);
      expect(res.body.error).toBe("RATE_LIMIT_EXCEEDED");
    } finally {
      await new Promise((resolve) => tempServer.close(resolve));
    }
  });
});
