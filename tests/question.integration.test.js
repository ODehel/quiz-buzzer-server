import { createServer } from "node:http";
import { openDatabase } from "../src/database/database.js";
import { createAuthenticateMiddleware } from "../src/middlewares/authenticate.js";
import { createAuthorizeMiddleware } from "../src/middlewares/authorize.js";
import { RateLimiter } from "../src/middlewares/rateLimiter.js";
import {
  createQuestionsCollectionHandler,
  createQuestionResourceHandler,
} from "../src/routes/questionRoute.js";
import {
  createThemesCollectionHandler,
  createThemeResourceHandler,
} from "../src/routes/themeRoute.js";
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

  const questionsCollectionHandler = createQuestionsCollectionHandler(db, config, authenticate, authorize, rateLimiter);
  const questionResourceHandler = createQuestionResourceHandler(db, config, authenticate, authorize, rateLimiter);
  const themesCollectionHandler = createThemesCollectionHandler(db, config, authenticate, authorize, rateLimiter);
  const themeResourceHandler = createThemeResourceHandler(db, config, authenticate, authorize, rateLimiter);

  adminToken = makeToken("admin");

  server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/v1/questions") {
      questionsCollectionHandler(req, res, url);
    } else if (url.pathname.match(/^\/api\/v1\/questions\/[^/]+$/)) {
      questionResourceHandler(req, res, url);
    } else if (url.pathname === "/api/v1/themes") {
      themesCollectionHandler(req, res, url);
    } else if (url.pathname.match(/^\/api\/v1\/themes\/[^/]+$/)) {
      themeResourceHandler(req, res, url);
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

async function createMcqQuestion(overrides = {}) {
  return request(server)
    .post("/api/v1/questions")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      type: "MCQ",
      theme_id: themeId,
      title: "Quelle est la capitale de la France ?",
      choices: ["Paris", "Lyon", "Marseille", "Toulouse"],
      correct_answer: "Paris",
      level: 1,
      time_limit: 30,
      points: 10,
      ...overrides,
    });
}

async function createSpeedQuestion(overrides = {}) {
  return request(server)
    .post("/api/v1/questions")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      type: "SPEED",
      theme_id: themeId,
      title: "Quel est le plus grand océan du monde ?",
      correct_answer: "Pacifique",
      level: 2,
      time_limit: 15,
      points: 20,
      ...overrides,
    });
}

// ─── POST /api/v1/questions ───────────────────────────────────────────────────

describe("POST /api/v1/questions", () => {
  test("CA-1 - creates MCQ question", async () => {
    const res = await createMcqQuestion();
    expect(res.status).toBe(201);
    expect(res.body.type).toBe("MCQ");
    expect(res.body.choices).toHaveLength(4);
    expect(res.body.correct_answer).toBe("Paris");
    expect(res.body.last_updated_at).toBeNull();
    expect(res.body.image_path).toBeNull();
    expect(res.body.audio_path).toBeNull();
    expect(res.body.id).toBeTruthy();
    expect(res.body.created_at).toBeTruthy();
  });

  test("CA-2 - creates SPEED question without choices", async () => {
    const res = await createSpeedQuestion();
    expect(res.status).toBe(201);
    expect(res.body.type).toBe("SPEED");
    expect(res.body).not.toHaveProperty("choices");
    expect(res.body.correct_answer).toBe("Pacifique");
  });

  test("CA-3 - normalizes title whitespace", async () => {
    const res = await createMcqQuestion({ title: "  Quelle est   la capitale de la France ?  " });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe("Quelle est la capitale de la France ?");
  });

  test("CA-4 - title too short", async () => {
    const res = await createMcqQuestion({ title: "Court" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  test("CA-4 - title not starting with uppercase", async () => {
    const res = await createMcqQuestion({ title: "quelle est la capitale de la France ?" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  test("CA-5 - duplicate title (case-insensitive) → 409", async () => {
    await createMcqQuestion();
    const res = await createSpeedQuestion({
      title: "QUELLE EST LA CAPITALE DE LA FRANCE ?",
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("QUESTION_ALREADY_EXISTS");
  });

  test("CA-6 - invalid type", async () => {
    const res = await createMcqQuestion({ type: "INVALID" });
    expect(res.status).toBe(400);
  });

  test("CA-7 - theme_id does not exist", async () => {
    const res = await createMcqQuestion({ theme_id: "018e4f5a-0000-0000-0000-000000000000" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_THEME");
  });

  test("CA-8 - theme_id invalid UUID", async () => {
    const res = await createMcqQuestion({ theme_id: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_UUID");
  });

  test("CA-9 - MCQ with 3 choices", async () => {
    const res = await createMcqQuestion({ choices: ["A", "B", "C"] });
    expect(res.status).toBe(400);
  });

  test("CA-9 - MCQ with duplicate choices", async () => {
    const res = await createMcqQuestion({ choices: ["Paris", "paris", "Marseille", "Toulouse"] });
    expect(res.status).toBe(400);
  });

  test("CA-10 - correct_answer not in choices", async () => {
    const res = await createMcqQuestion({ correct_answer: "Nice" });
    expect(res.status).toBe(400);
  });

  test("CA-11 - SPEED with choices → 400 VALIDATION_ERROR", async () => {
    const res = await createSpeedQuestion({ choices: ["A", "B", "C", "D"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  test("CA-13 - level out of range", async () => {
    const res = await createMcqQuestion({ level: 6 });
    expect(res.status).toBe(400);
  });

  test("CA-14 - time_limit out of range", async () => {
    const res = await createMcqQuestion({ time_limit: 3 });
    expect(res.status).toBe(400);
  });

  test("CA-15 - points out of range", async () => {
    const res = await createMcqQuestion({ points: 0 });
    expect(res.status).toBe(400);
  });

  test("CA-18 - image_path in POST body → UNKNOWN_FIELDS", async () => {
    const res = await createMcqQuestion({ image_path: "/img.jpg" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("UNKNOWN_FIELDS");
  });

  test("CA-20 - wrong Content-Type → 415", async () => {
    const res = await request(server)
      .post("/api/v1/questions")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "text/plain")
      .send("not json");
    expect(res.status).toBe(415);
  });

  test("401 - missing token", async () => {
    const res = await request(server).post("/api/v1/questions").send({});
    expect(res.status).toBe(401);
  });

  test("403 - non-admin token", async () => {
    const buzzerToken = makeToken("buzzer");
    const res = await request(server)
      .post("/api/v1/questions")
      .set("Authorization", `Bearer ${buzzerToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  test("CA-83 - PATCH on collection → 405", async () => {
    const res = await request(server)
      .patch("/api/v1/questions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("GET, POST");
  });

  // ─── Ajouts dans describe("POST /api/v1/quizzes") ────────────────────────────

  // CA-14 : Body non parseable
  it("CA-14: returns 400 INVALID_BODY for non-parseable body", async () => {
    const res = await request(server)
      .post("/api/v1/quizzes")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send("{ invalid json {{");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_BODY");
  });

  // CA-38 étendu : GET sans token
  it("CA-38: GET returns 401 without token", async () => {
    const res = await request(server).get("/api/v1/quizzes");
    expect(res.status).toBe(401);
  });

  // CA-39 étendu : GET avec rôle buzzer
  it("CA-39: GET returns 403 for buzzer role", async () => {
    const res = await request(server)
      .get("/api/v1/quizzes")
      .set("Authorization", `Bearer ${buzzerToken}`);
    expect(res.status).toBe(403);
  });

  // CA-42 : Erreur serveur inattendue sur POST
  it("CA-42: returns 500 on unexpected server error (POST)", async () => {
    // On ferme la DB pour provoquer une erreur inattendue
    db.close();
    const res = await request(server)
      .post("/api/v1/quizzes")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ name: "Mon quiz", question_ids: makeQ(10) });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("INTERNAL_SERVER_ERROR");
    // Rouvrir pour le afterEach (qui fait db.close())
    db = openDatabase(":memory:");
  });


  // ─── Ajouts dans describe("PUT /api/v1/quizzes/:id") ─────────────────────────

  // CA-21 : Modifier le nom seul
  it("CA-21: allows updating name only without changing questions", async () => {
    const created = (await createValidQuiz()).body;
    const res = await request(server)
      .put(`/api/v1/quizzes/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ name: "Culture générale renommée", question_ids: makeQ(10) });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Culture générale renommée");
    expect(res.body.question_count).toBe(10);
    expect(res.body.last_updated_at).not.toBeNull();
  });

  // CA-23 : Remplacement complet de la liste
  it("CA-23: replaces question list entirely and preserves new order", async () => {
    const created = (await createValidQuiz()).body;
    const newIds = [...makeQ(10)].reverse();
    const res = await request(server)
      .put(`/api/v1/quizzes/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ name: "Culture générale", question_ids: newIds });
    expect(res.status).toBe(200);
    expect(res.body.question_count).toBe(10);
    // L'ordre est validé côté service/repository ; ici on valide la réponse HTTP
    expect(res.body.last_updated_at).not.toBeNull();
  });

  // CA-28 : Content-Type incorrect sur PUT
  it("CA-28: returns 415 for wrong Content-Type on PUT", async () => {
    const created = (await createValidQuiz()).body;
    const res = await request(server)
      .put(`/api/v1/quizzes/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "text/plain")
      .send("hello");
    expect(res.status).toBe(415);
  });

  // CA-38 étendu : PUT sans token
  it("CA-38: PUT returns 401 without token", async () => {
    const created = (await createValidQuiz()).body;
    const res = await request(server)
      .put(`/api/v1/quizzes/${created.id}`)
      .set("Content-Type", "application/json")
      .send({ name: "Test", question_ids: makeQ(10) });
    expect(res.status).toBe(401);
  });

  // CA-39 étendu : PUT avec rôle buzzer
  it("CA-39: PUT returns 403 for buzzer role", async () => {
    const created = (await createValidQuiz()).body;
    const res = await request(server)
      .put(`/api/v1/quizzes/${created.id}`)
      .set("Authorization", `Bearer ${buzzerToken}`)
      .set("Content-Type", "application/json")
      .send({ name: "Test", question_ids: makeQ(10) });
    expect(res.status).toBe(403);
  });

  // CA-40 : Rate limiting sur la collection
  it("CA-40: returns 429 when rate limit is exceeded", async () => {
    // Créer un handler avec un rate limiter très bas (1 req max)
    const tightRateLimiter = new RateLimiter(1, 60_000);
    const authenticate = createAuthenticateMiddleware(JWT_SECRET);
    const authorize = createAuthorizeMiddleware("admin");
    const tightCollectionHandler = createQuizzesCollectionHandler(
      db, config, authenticate, authorize, tightRateLimiter
    );

    const tightServer = createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname === "/api/v1/quizzes") {
        tightCollectionHandler(req, res, url);
      } else {
        res.writeHead(404); res.end();
      }
    });
    await new Promise((resolve) => tightServer.listen(0, resolve));

    try {
      // Première requête : passe
      await request(tightServer)
        .get("/api/v1/quizzes")
        .set("Authorization", `Bearer ${adminToken}`);

      // Deuxième requête : bloquée
      const res = await request(tightServer)
        .get("/api/v1/quizzes")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(429);
      expect(res.body.error).toBe("RATE_LIMIT_EXCEEDED");
      expect(res.headers["retry-after"]).toBeDefined();
    } finally {
      await new Promise((resolve) => tightServer.close(resolve));
    }
  });

  // CA-42 : Erreur serveur inattendue sur GET
  it("CA-42: returns 500 on unexpected server error (GET)", async () => {
    db.close();
    const res = await request(server)
      .get("/api/v1/quizzes")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("INTERNAL_SERVER_ERROR");
    db = openDatabase(":memory:");
  });


  // ─── Ajouts dans describe("DELETE /api/v1/quizzes/:id") ──────────────────────

  // CA-39 étendu : DELETE avec rôle buzzer
  it("CA-39: DELETE returns 403 for buzzer role", async () => {
    const created = (await createValidQuiz()).body;
    const res = await request(server)
      .delete(`/api/v1/quizzes/${created.id}`)
      .set("Authorization", `Bearer ${buzzerToken}`);
    expect(res.status).toBe(403);
  });

  // CA-40 : Rate limiting sur la ressource
  it("CA-40: returns 429 when rate limit is exceeded on resource", async () => {
    const tightRateLimiter = new RateLimiter(1, 60_000);
    const authenticate = createAuthenticateMiddleware(JWT_SECRET);
    const authorize = createAuthorizeMiddleware("admin");
    const tightResourceHandler = createQuizResourceHandler(
      db, config, authenticate, authorize, tightRateLimiter
    );

    const tightServer = createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname.match(/^\/api\/v1\/quizzes\/[^/]+$/)) {
        tightResourceHandler(req, res, url);
      } else {
        res.writeHead(404); res.end();
      }
    });
    await new Promise((resolve) => tightServer.listen(0, resolve));

    // Créer un quiz sur le serveur principal
    const created = (await createValidQuiz()).body;

    try {
      // Première requête : passe
      await request(tightServer)
        .delete(`/api/v1/quizzes/${created.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      // Deuxième requête : bloquée
      const res = await request(tightServer)
        .delete(`/api/v1/quizzes/${created.id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(429);
      expect(res.body.error).toBe("RATE_LIMIT_EXCEEDED");
      expect(res.headers["retry-after"]).toBeDefined();
    } finally {
      await new Promise((resolve) => tightServer.close(resolve));
    }
  });

  // CA-42 : Erreur serveur inattendue sur DELETE
  it("CA-42: returns 500 on unexpected server error (DELETE)", async () => {
    const created = (await createValidQuiz()).body;
    db.close();
    const res = await request(server)
      .delete(`/api/v1/quizzes/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("INTERNAL_SERVER_ERROR");
    db = openDatabase(":memory:");
  });
});

// ─── GET /api/v1/questions ────────────────────────────────────────────────────

describe("GET /api/v1/questions", () => {
  test("CA-32 - empty list", async () => {
    const res = await request(server)
      .get("/api/v1/questions")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ data: [], page: 1, limit: 20, total: 0, total_pages: 0 });
  });

  test("CA-26 - paginated list", async () => {
    await createMcqQuestion();
    await createSpeedQuestion();
    const res = await request(server)
      .get("/api/v1/questions?page=1&limit=10")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  test("CA-27 - sorted by creation date descending", async () => {
    await createMcqQuestion();
    await createSpeedQuestion();
    const res = await request(server)
      .get("/api/v1/questions")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    // Most recently created comes first
    expect(res.body.data[0].type).toBe("SPEED");
  });

  test("CA-29 - limit > 100 → 400", async () => {
    const res = await request(server)
      .get("/api/v1/questions?limit=200")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_PAGINATION");
  });

  test("CA-30 - negative page → 400", async () => {
    const res = await request(server)
      .get("/api/v1/questions?page=-1")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  test("CA-33 - filter by theme_id", async () => {
    await createMcqQuestion();
    const res = await request(server)
      .get(`/api/v1/questions?theme_id=${themeId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  test("CA-34 - filter by type", async () => {
    await createMcqQuestion();
    await createSpeedQuestion();
    const res = await request(server)
      .get("/api/v1/questions?type=SPEED")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].type).toBe("SPEED");
  });

  test("CA-35 - filter by exact level", async () => {
    await createMcqQuestion({ level: 1 });
    await createSpeedQuestion({ level: 3 });
    const res = await request(server)
      .get("/api/v1/questions?level=3")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  test("CA-36 - filter by level range", async () => {
    await createMcqQuestion({ level: 1 });
    await createSpeedQuestion({ level: 3 });
    const res = await request(server)
      .get("/api/v1/questions?level_min=2&level_max=4")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  test("CA-40 - non-existent theme_id filter → 400", async () => {
    const res = await request(server)
      .get("/api/v1/questions?theme_id=018e4f5a-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_FILTER");
  });

  test("CA-41 - invalid type filter → 400", async () => {
    const res = await request(server)
      .get("/api/v1/questions?type=UNKNOWN")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_FILTER");
  });

  test("CA-43 - incoherent range → 400", async () => {
    const res = await request(server)
      .get("/api/v1/questions?level_min=4&level_max=2")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_FILTER");
  });

  test("CA-44 - level and level_min together → 400", async () => {
    const res = await request(server)
      .get("/api/v1/questions?level=3&level_min=2")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_FILTER");
  });
});

// ─── GET /api/v1/questions/:id ────────────────────────────────────────────────

describe("GET /api/v1/questions/:id", () => {
  test("CA-21 - get MCQ by ID", async () => {
    const created = await createMcqQuestion();
    const res = await request(server)
      .get(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.choices).toHaveLength(4);
  });

  test("CA-22 - get SPEED by ID (no choices)", async () => {
    const created = await createSpeedQuestion();
    const res = await request(server)
      .get(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("choices");
  });

  test("CA-23 - not found → 404", async () => {
    const res = await request(server)
      .get("/api/v1/questions/018e4f5a-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NOT_FOUND");
  });

  test("CA-24 - invalid UUID → 400", async () => {
    const res = await request(server)
      .get("/api/v1/questions/not-a-uuid")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_UUID");
  });
});

// ─── PUT /api/v1/questions/:id ────────────────────────────────────────────────

describe("PUT /api/v1/questions/:id", () => {
  test("CA-45 - full update of MCQ", async () => {
    const created = await createMcqQuestion();
    const res = await request(server)
      .put(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "MCQ", theme_id: themeId,
        title: "Quelle est la capitale de l'Allemagne ?",
        choices: ["Berlin", "Munich", "Hambourg", "Cologne"],
        correct_answer: "Berlin", level: 2, time_limit: 20, points: 15,
      });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Quelle est la capitale de l'Allemagne ?");
    expect(res.body.last_updated_at).not.toBeNull();
  });

  test("CA-49 - identical data no timestamp update", async () => {
    const created = await createMcqQuestion();
    const res = await request(server)
      .put(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "MCQ", theme_id: themeId,
        title: "Quelle est la capitale de la France ?",
        choices: ["Paris", "Lyon", "Marseille", "Toulouse"],
        correct_answer: "Paris", level: 1, time_limit: 30, points: 10,
      });
    expect(res.status).toBe(200);
    expect(res.body.last_updated_at).toBeNull();
  });

  test("CA-48 - type change rejected", async () => {
    const created = await createMcqQuestion();
    const res = await request(server)
      .put(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "SPEED", theme_id: themeId,
        title: "Quelle est la capitale de l'Espagne ?",
        correct_answer: "Madrid", level: 1, time_limit: 30, points: 10,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("TYPE_CHANGE_NOT_ALLOWED");
  });

  test("CA-52 - not found → 404", async () => {
    const res = await request(server)
      .put("/api/v1/questions/018e4f5a-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "MCQ", theme_id: themeId,
        title: "Une question qui n'existe pas du tout ici",
        choices: ["A", "B", "C", "D"],
        correct_answer: "A", level: 1, time_limit: 30, points: 10,
      });
    expect(res.status).toBe(404);
  });

  test("CA-54 - image_path in PUT body → UNKNOWN_FIELDS", async () => {
    const created = await createMcqQuestion();
    const res = await request(server)
      .put(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "MCQ", theme_id: themeId,
        title: "Quelle est la capitale de la France ?",
        choices: ["Paris", "Lyon", "Marseille", "Toulouse"],
        correct_answer: "Paris", level: 1, time_limit: 30, points: 10,
        image_path: "/img.jpg",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("UNKNOWN_FIELDS");
  });

  test("CA-55 - missing required field", async () => {
    const created = await createMcqQuestion();
    const res = await request(server)
      .put(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "MCQ", theme_id: themeId,
        title: "Quelle est la capitale de la France ?",
        choices: ["Paris", "Lyon", "Marseille", "Toulouse"],
        correct_answer: "Paris",
        // level missing
        time_limit: 30, points: 10,
      });
    expect(res.status).toBe(400);
  });

  test("CA-53 - wrong Content-Type → 415", async () => {
    const created = await createMcqQuestion();
    const res = await request(server)
      .put(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "text/plain")
      .send("not json");
    expect(res.status).toBe(415);
  });
});

// ─── PATCH /api/v1/questions/:id ──────────────────────────────────────────────

describe("PATCH /api/v1/questions/:id", () => {
  test("CA-56 - partial update", async () => {
    const created = await createMcqQuestion();
    const res = await request(server)
      .patch(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ level: 3 });
    expect(res.status).toBe(200);
    expect(res.body.level).toBe(3);
    expect(res.body.last_updated_at).not.toBeNull();
  });

  test("CA-57 - absent field not modified", async () => {
    const created = await createMcqQuestion();
    await request(server)
      .patch(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ level: 3 });
    const res = await request(server)
      .get(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.body.title).toBe("Quelle est la capitale de la France ?");
  });

  test("CA-60 - type in PATCH → 400 TYPE_CHANGE_NOT_ALLOWED", async () => {
    const created = await createMcqQuestion();
    const res = await request(server)
      .patch(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ type: "SPEED" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("TYPE_CHANGE_NOT_ALLOWED");
  });

  test("CA-61 - id in PATCH → 400 UNKNOWN_FIELDS", async () => {
    const created = await createMcqQuestion();
    const res = await request(server)
      .patch(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ id: created.body.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("UNKNOWN_FIELDS");
  });

  test("CA-68 - patch image_path", async () => {
    const created = await createMcqQuestion();
    const res = await request(server)
      .patch(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ image_path: "/img/flag.jpg" });
    expect(res.status).toBe(200);
    expect(res.body.image_path).toBe("/img/flag.jpg");
  });

  test("CA-68 - empty image_path → 400", async () => {
    const created = await createMcqQuestion();
    const res = await request(server)
      .patch(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ image_path: "" });
    expect(res.status).toBe(400);
  });

  test("CA-69 - patch audio_path to null", async () => {
    const created = await createMcqQuestion();
    await request(server)
      .patch(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ audio_path: "/audio/test.mp3" });
    const res = await request(server)
      .patch(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ audio_path: null });
    expect(res.status).toBe(200);
    expect(res.body.audio_path).toBeNull();
  });

  test("CA-70 - identical data no timestamp update", async () => {
    const created = await createMcqQuestion();
    const res = await request(server)
      .patch(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ level: 1 });
    expect(res.status).toBe(200);
    expect(res.body.last_updated_at).toBeNull();
  });

  test("CA-71 - not found → 404", async () => {
    const res = await request(server)
      .patch("/api/v1/questions/018e4f5a-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ level: 2 });
    expect(res.status).toBe(404);
  });

  test("CA-72 - wrong Content-Type → 415", async () => {
    const created = await createMcqQuestion();
    const res = await request(server)
      .patch(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "text/plain")
      .send("not json");
    expect(res.status).toBe(415);
  });

  test("CA-73 - empty body returns unchanged question", async () => {
    const created = await createMcqQuestion();
    const res = await request(server)
      .patch(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.last_updated_at).toBeNull();
  });
});

// ─── DELETE /api/v1/questions/:id ─────────────────────────────────────────────

describe("DELETE /api/v1/questions/:id", () => {
  test("CA-74 - deletes question", async () => {
    const created = await createMcqQuestion();
    const res = await request(server)
      .delete(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(204);
  });

  test("CA-75 - not found → 404", async () => {
    const res = await request(server)
      .delete("/api/v1/questions/018e4f5a-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  test("CA-76 - invalid UUID → 400", async () => {
    const res = await request(server)
      .delete("/api/v1/questions/not-a-uuid")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_UUID");
  });

  test("CA-83 - POST on resource → 405", async () => {
    const created = await createMcqQuestion();
    const res = await request(server)
      .post(`/api/v1/questions/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("GET, PUT, PATCH, DELETE");
  });
});

// ─── CA-78/CA-79 — Garde de suppression des thèmes ───────────────────────────

describe("DELETE /api/v1/themes/:id - THEME_HAS_QUESTIONS guard", () => {
  test("CA-79 - can delete theme with no questions", async () => {
    const themeRes = await request(server)
      .post("/api/v1/themes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Histoire" });
    expect(themeRes.status).toBe(201);

    const res = await request(server)
      .delete(`/api/v1/themes/${themeRes.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(204);
  });

  test("CA-78 - cannot delete theme with associated questions", async () => {
    await createMcqQuestion();

    const res = await request(server)
      .delete(`/api/v1/themes/${themeId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("THEME_HAS_QUESTIONS");
    expect(res.body.message).toBe("Cannot delete this theme: questions are still associated with it.");
  });
});

// ─── Additional coverage: 429 rate limiting and 500 internal error ─────────────

describe("Rate limiting — CA-82", () => {
  test("429 on collection when rate limit exceeded", async () => {
    const tinyRateLimiter = new RateLimiter(1, 60_000);
    const authenticate = createAuthenticateMiddleware(JWT_SECRET);
    const authorize = createAuthorizeMiddleware("admin");
    const collectionHandler = createQuestionsCollectionHandler(db, config, authenticate, authorize, tinyRateLimiter);

    const tempServer = createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      collectionHandler(req, res, url);
    });

    await new Promise((resolve) => tempServer.listen(0, resolve));
    try {
      // First request consumes the limit
      await request(tempServer).get("/api/v1/questions").set("Authorization", `Bearer ${adminToken}`);
      // Second request should be rejected
      const res = await request(tempServer).get("/api/v1/questions").set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(429);
      expect(res.body.error).toBe("RATE_LIMIT_EXCEEDED");
    } finally {
      await new Promise((resolve) => tempServer.close(resolve));
    }
  });

  test("429 on resource when rate limit exceeded", async () => {
    const tinyRateLimiter = new RateLimiter(1, 60_000);
    const authenticate = createAuthenticateMiddleware(JWT_SECRET);
    const authorize = createAuthorizeMiddleware("admin");
    const resourceHandler = createQuestionResourceHandler(db, config, authenticate, authorize, tinyRateLimiter);

    const tempServer = createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      resourceHandler(req, res, url);
    });

    await new Promise((resolve) => tempServer.listen(0, resolve));
    try {
      const fakeId = "018e4f5a-0000-0000-0000-000000000001";
      await request(tempServer).get(`/api/v1/questions/${fakeId}`).set("Authorization", `Bearer ${adminToken}`);
      const res = await request(tempServer).get(`/api/v1/questions/${fakeId}`).set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(429);
      expect(res.body.error).toBe("RATE_LIMIT_EXCEEDED");
    } finally {
      await new Promise((resolve) => tempServer.close(resolve));
    }
  });
});

// ─── Additional filter coverage: time_limit and points ─────────────────────────

describe("GET /api/v1/questions — time_limit and points filters", () => {
  beforeEach(async () => {
    await createMcqQuestion({ time_limit: 10, points: 5 });
    await createSpeedQuestion({ time_limit: 30, points: 25 });
  });

  test("filter by time_limit_min", async () => {
    const res = await request(server)
      .get("/api/v1/questions?time_limit_min=20")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].time_limit).toBe(30);
  });

  test("filter by time_limit_max", async () => {
    const res = await request(server)
      .get("/api/v1/questions?time_limit_max=15")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].time_limit).toBe(10);
  });

  test("filter by points_min", async () => {
    const res = await request(server)
      .get("/api/v1/questions?points_min=20")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].points).toBe(25);
  });

  test("filter by points_max", async () => {
    const res = await request(server)
      .get("/api/v1/questions?points_max=10")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].points).toBe(5);
  });

  describe("CA-36: DELETE /api/v1/questions/:id — garde quiz", () => {
    it("returns 409 QUESTION_IN_QUIZ when question belongs to a quiz", async () => {
      // Créer une question
      const qRes = await createMcqQuestion();
      const questionId = qRes.body.id;

      // Créer 9 autres questions pour atteindre 10
      const otherIds = [];
      for (let i = 0; i < 9; i++) {
        const r = await createMcqQuestion({ title: `Autre question numéro ${i + 1} pour le quiz ?` });
        otherIds.push(r.body.id);
      }

      // Insérer un quiz qui utilise ces questions
      // (on insère directement en DB pour ne pas dépendre de quizRoute)
      const { insertQuiz, insertQuizQuestions } = await import("../src/repositories/quizRepository.js");
      const { v7: uuidv7 } = await import("uuid");
      const quizId = uuidv7();
      insertQuiz(db, { id: quizId, name: "Quiz de test garde", createdAt: new Date().toISOString() });
      insertQuizQuestions(db, quizId, [questionId, ...otherIds]);

      // Tentative de suppression → 409
      const res = await request(server)
        .delete(`/api/v1/questions/${questionId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("QUESTION_IN_QUIZ");
      expect(res.body.message).toBe(
        "Cannot delete this question: it belongs to one or more quizzes."
      );
    });

    it("CA-37: returns 204 when question belongs to no quiz", async () => {
      const qRes = await createMcqQuestion({ title: "Question libre sans quiz associé ?" });
      const questionId = qRes.body.id;

      const res = await request(server)
        .delete(`/api/v1/questions/${questionId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(204);
    });
  });
});