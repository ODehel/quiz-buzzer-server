import { createServer } from "node:http";
import { openDatabase } from "../../src/database/database.js";
import { createAuthenticateMiddleware } from "../../src/middlewares/authenticate.js";
import { createAuthorizeMiddleware } from "../../src/middlewares/authorize.js";
import { RateLimiter } from "../../src/middlewares/rateLimiter.js";
import {
  createQuizzesCollectionHandler,
  createQuizResourceHandler,
} from "../../src/routes/quizRoute.js";
import jwt from "jsonwebtoken";
import request from "supertest";

const JWT_SECRET = "a".repeat(32);
const config = { jwtSecret: JWT_SECRET, jwtExpiration: 3600 };

let db, server, adminToken, buzzerToken;

function makeToken(role = "admin") {
  return jwt.sign(
    { sub: "018e4f5a-8c3b-7d2e-9f1a-000000000001", role },
    JWT_SECRET,
    { algorithm: "HS256", expiresIn: 3600 }
  );
}

// Génère n UUIDs de questions existantes
function makeQ(n) {
  return Array.from({ length: n }, (_, i) => `00000000-0000-7000-8000-${String(i + 1).padStart(12, "0")}`);
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach((done) => {
  db = openDatabase(":memory:");

  // Thème
  db.prepare(
    `INSERT INTO T_THEME_THM (THM_ID, THM_NAME, THM_CREATED_AT) VALUES (?, ?, ?)`
  ).run("thm-1", "Science", "2026-03-13T10:00:00.000Z");

  // 15 questions
  for (let i = 1; i <= 15; i++) {
    db.prepare(
      `INSERT INTO T_QUESTION_QST
         (QST_ID, QST_TYPE, QST_THEME_ID, QST_TITLE,
          QST_CORRECT_ANSWER, QST_LEVEL, QST_TIME_LIMIT, QST_POINTS, QST_CREATED_AT)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`,
      i % 2 === 0 ? "MCQ" : "SPEED",
      "thm-1",
      `Question numéro ${i} valide pour un quiz de test ?`,
      "Réponse", (i % 5) + 1, 30, 5, "2026-03-13T10:00:00.000Z"
    );
  }

  const authenticate = createAuthenticateMiddleware(JWT_SECRET);
  const authorize = createAuthorizeMiddleware("admin");
  const rateLimiter = new RateLimiter(100, 60_000);

  const collectionHandler = createQuizzesCollectionHandler(
    db, config, authenticate, authorize, rateLimiter
  );
  const resourceHandler = createQuizResourceHandler(
    db, config, authenticate, authorize, rateLimiter
  );

  adminToken = makeToken("admin");
  buzzerToken = makeToken("buzzer");

  server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/v1/quizzes") {
      collectionHandler(req, res, url);
    } else if (url.pathname.match(/^\/api\/v1\/quizzes\/[^\/]+$/)) {
      resourceHandler(req, res, url);
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

async function createValidQuiz(name = "Culture générale", n = 10) {
  return request(server)
    .post("/api/v1/quizzes")
    .set("Authorization", `Bearer ${adminToken}`)
    .set("Content-Type", "application/json")
    .send({ name, question_ids: makeQ(n) });
}

// ─── POST /api/v1/quizzes ─────────────────────────────────────────────────────

describe("POST /api/v1/quizzes", () => {
  it("CA-1: creates a quiz and returns 201", async () => {
    const res = await createValidQuiz();
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Culture générale");
    expect(res.body.question_count).toBe(10);
    expect(res.body.last_updated_at).toBeNull();
    expect(res.body.id).toBeDefined();
    expect(res.body.created_at).toBeDefined();
  });

  it("CA-3: returns 400 for invalid name", async () => {
    const res = await request(server)
      .post("/api/v1/quizzes")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ name: "culture générale", question_ids: makeQ(10) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  it("CA-4: returns 409 for duplicate name", async () => {
    await createValidQuiz("Sciences du monde");
    const res = await createValidQuiz("SCIENCES DU MONDE");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("QUIZ_ALREADY_EXISTS");
  });

  it("CA-5: returns 400 for less than 10 questions", async () => {
    const res = await request(server)
      .post("/api/v1/quizzes")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ name: "Mon quiz", question_ids: makeQ(3) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  it("CA-6: returns 400 for duplicate question IDs", async () => {
    const ids = makeQ(10);
    ids[1] = ids[0]; // doublon
    const res = await request(server)
      .post("/api/v1/quizzes")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ name: "Mon quiz", question_ids: ids });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  it("CA-7: returns 400 for invalid UUID in question_ids", async () => {
    const ids = makeQ(10);
    ids[0] = "not-a-uuid";
    const res = await request(server)
      .post("/api/v1/quizzes")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ name: "Mon quiz", question_ids: ids });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_UUID");
  });

  it("CA-8: returns 404 for non-existent question", async () => {
    const ids = ["018e4f5a-0000-0000-0000-000000000000", ...makeQ(9).slice(0)];
    const res = await request(server)
      .post("/api/v1/quizzes")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ name: "Mon quiz", question_ids: ids });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("QUESTION_NOT_FOUND");
  });

  it("CA-12: returns 400 for unknown fields", async () => {
    const res = await request(server)
      .post("/api/v1/quizzes")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ name: "Mon quiz", question_ids: makeQ(10), extra: "field" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("UNKNOWN_FIELDS");
  });

  it("CA-13: returns 415 for wrong Content-Type", async () => {
    const res = await request(server)
      .post("/api/v1/quizzes")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "text/plain")
      .send("hello");
    expect(res.status).toBe(415);
  });

  it("CA-38: returns 401 without token", async () => {
    const res = await request(server)
      .post("/api/v1/quizzes")
      .set("Content-Type", "application/json")
      .send({ name: "Mon quiz", question_ids: makeQ(10) });
    expect(res.status).toBe(401);
  });

  it("CA-39: returns 403 for buzzer role", async () => {
    const res = await request(server)
      .post("/api/v1/quizzes")
      .set("Authorization", `Bearer ${buzzerToken}`)
      .set("Content-Type", "application/json")
      .send({ name: "Mon quiz", question_ids: makeQ(10) });
    expect(res.status).toBe(403);
  });

  it("CA-41: returns 405 for PATCH on collection", async () => {
    const res = await request(server)
      .patch("/api/v1/quizzes")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toContain("GET");
    expect(res.headers["allow"]).toContain("POST");
  });
});

// ─── GET /api/v1/quizzes ──────────────────────────────────────────────────────

describe("GET /api/v1/quizzes", () => {
  it("CA-15: returns 200 with paginated list", async () => {
    await createValidQuiz();
    const res = await request(server)
      .get("/api/v1/quizzes")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("page", 1);
    expect(res.body).toHaveProperty("limit", 20);
    expect(res.body).toHaveProperty("total", 1);
    expect(res.body).toHaveProperty("total_pages", 1);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(1);
  });

  it("CA-16: returns 200 with empty pagination when no quizzes", async () => {
    const res = await request(server)
      .get("/api/v1/quizzes")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [],
      page: 1,
      limit: 20,
      total: 0,
      total_pages: 0,
    });
  });

  it("CA-18: filters by ?name=", async () => {
    await createValidQuiz("Culture générale", 10);
    await createValidQuiz("Sport et loisirs", 12);
    const res = await request(server)
      .get("/api/v1/quizzes?name=culture")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe("Culture générale");
  });

  it("CA-19: includes question_summary in each quiz", async () => {
    await createValidQuiz();
    const res = await request(server)
      .get("/api/v1/quizzes")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.body.data[0].question_summary).toBeDefined();
    expect(res.body.data[0].question_summary.total).toBe(10);

    // Verify all levels 1-5 are present with MCQ and SPEED properties
    const { by_level } = res.body.data[0].question_summary;
    for (let lvl = 1; lvl <= 5; lvl++) {
      expect(by_level[String(lvl)]).toBeDefined();
      expect(by_level[String(lvl)].MCQ).toBeDefined();
      expect(by_level[String(lvl)].SPEED).toBeDefined();
      expect(typeof by_level[String(lvl)].MCQ).toBe("number");
      expect(typeof by_level[String(lvl)].SPEED).toBe("number");
    }
  });

  it("CA-20: applies default pagination (page=1, limit=20)", async () => {
    await createValidQuiz();
    const res = await request(server)
      .get("/api/v1/quizzes")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(20);
  });

  it("CA-21: returns 400 when limit > 100", async () => {
    const res = await request(server)
      .get("/api/v1/quizzes?limit=200")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_PAGINATION");
  });

  it("CA-22: returns 400 for invalid pagination parameters", async () => {
    let res = await request(server)
      .get("/api/v1/quizzes?page=0")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_PAGINATION");

    res = await request(server)
      .get("/api/v1/quizzes?limit=-1")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_PAGINATION");

    res = await request(server)
      .get("/api/v1/quizzes?page=abc")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_PAGINATION");
  });

  it("CA-23: returns empty data when page beyond total", async () => {
    await createValidQuiz();
    const res = await request(server)
      .get("/api/v1/quizzes?page=999")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.page).toBe(999);
    expect(res.body.total).toBe(1);
    expect(res.body.total_pages).toBe(1);
  });
});

// ─── GET /api/v1/quizzes/:id ──────────────────────────────────────────────────

describe("GET /api/v1/quizzes/:id", () => {
  it("CA-24: retrieves quiz with all question_ids in order", async () => {
    const created = (await createValidQuiz("Culture générale", 10)).body;
    const res = await request(server)
      .get(`/api/v1/quizzes/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.id);
    expect(res.body.name).toBe("Culture générale");
    expect(res.body.question_ids).toBeDefined();
    expect(Array.isArray(res.body.question_ids)).toBe(true);
    expect(res.body.question_ids).toHaveLength(10);
    expect(res.body.created_at).toBeDefined();
    expect(res.body.last_updated_at).toBeNull();
  });

  it("CA-24: preserves question order from creation", async () => {
    const created = (await createValidQuiz("Test quiz")).body;
    const res = await request(server)
      .get(`/api/v1/quizzes/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.question_ids).toEqual(makeQ(10));
  });

  it("CA-25: returns 404 for non-existent quiz", async () => {
    const res = await request(server)
      .get("/api/v1/quizzes/018e4f5a-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NOT_FOUND");
  });

  it("CA-26: returns 400 for malformed UUID", async () => {
    const res = await request(server)
      .get("/api/v1/quizzes/not-a-uuid")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_UUID");
  });

  it("CA-38: returns 401 without token", async () => {
    const created = (await createValidQuiz()).body;
    const res = await request(server)
      .get(`/api/v1/quizzes/${created.id}`);

    expect(res.status).toBe(401);
  });

  it("CA-39: returns 403 for buzzer role", async () => {
    const created = (await createValidQuiz()).body;
    const res = await request(server)
      .get(`/api/v1/quizzes/${created.id}`)
      .set("Authorization", `Bearer ${buzzerToken}`);

    expect(res.status).toBe(403);
  });

  it("CA-41: returns 405 for PATCH on resource", async () => {
    const created = (await createValidQuiz()).body;
    const res = await request(server)
      .patch(`/api/v1/quizzes/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toContain("GET");
    expect(res.headers["allow"]).toContain("PUT");
    expect(res.headers["allow"]).toContain("DELETE");
  });
});

// ─── PUT /api/v1/quizzes/:id ─────────────────────────────────────────────────

describe("PUT /api/v1/quizzes/:id", () => {
  it("CA-20: updates quiz and returns 200", async () => {
    const created = (await createValidQuiz()).body;
    const res = await request(server)
      .put(`/api/v1/quizzes/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ name: "Culture générale modifié", question_ids: makeQ(12) });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Culture générale modifié");
    expect(res.body.question_count).toBe(12);
    expect(res.body.last_updated_at).not.toBeNull();
  });

  it("CA-24: returns 200 without modifying last_updated_at when identical", async () => {
    const created = (await createValidQuiz()).body;
    const res = await request(server)
      .put(`/api/v1/quizzes/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ name: "Culture générale", question_ids: makeQ(10) });
    expect(res.status).toBe(200);
    expect(res.body.last_updated_at).toBeNull();
  });

  it("CA-25: returns 400 ID_MISMATCH when body id differs from URL", async () => {
    const created = (await createValidQuiz()).body;
    const res = await request(server)
      .put(`/api/v1/quizzes/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({
        id: "018e4f5a-0000-0000-0000-000000000000",
        name: "Test",
        question_ids: makeQ(10),
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ID_MISMATCH");
  });

  it("CA-26: returns 404 for unknown quiz ID", async () => {
    const res = await request(server)
      .put("/api/v1/quizzes/018e4f5a-8c3b-7d2e-9f1a-000000000099")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ name: "Mon quiz", question_ids: makeQ(10) });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NOT_FOUND");
  });

  it("CA-27: returns 400 for malformed quiz ID", async () => {
    const res = await request(server)
      .put("/api/v1/quizzes/not-a-uuid")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ name: "Mon quiz", question_ids: makeQ(10) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_UUID");
  });

  it("CA-41: returns 405 for PATCH on resource", async () => {
    const created = (await createValidQuiz()).body;
    const res = await request(server)
      .patch(`/api/v1/quizzes/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toContain("GET");
    expect(res.headers["allow"]).toContain("PUT");
    expect(res.headers["allow"]).toContain("DELETE");
  });
});

// ─── DELETE /api/v1/quizzes/:id ───────────────────────────────────────────────

describe("DELETE /api/v1/quizzes/:id", () => {
  it("CA-29: deletes quiz and returns 204", async () => {
    const created = (await createValidQuiz()).body;
    const res = await request(server)
      .delete(`/api/v1/quizzes/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it("CA-33: returns 404 for unknown quiz ID", async () => {
    const res = await request(server)
      .delete("/api/v1/quizzes/018e4f5a-8c3b-7d2e-9f1a-000000000099")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NOT_FOUND");
  });

  it("CA-34: returns 400 for malformed quiz ID", async () => {
    const res = await request(server)
      .delete("/api/v1/quizzes/not-a-uuid")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_UUID");
  });

  it("CA-35: ignores a body silently and still returns 204", async () => {
    const created = (await createValidQuiz()).body;
    const res = await request(server)
      .delete(`/api/v1/quizzes/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ unexpected: "body" });
    expect(res.status).toBe(204);
  });

  it("CA-38: returns 401 without token", async () => {
    const created = (await createValidQuiz()).body;
    const res = await request(server)
      .delete(`/api/v1/quizzes/${created.id}`);
    expect(res.status).toBe(401);
  });
});
// ─── CA-14 : Invalid JSON body ────────────────────────────────────────────────

describe("POST /api/v1/quizzes — CA-14 invalid JSON body", () => {
  it("CA-14: returns 400 for non-parseable body", async () => {
    const res = await request(server)
      .post("/api/v1/quizzes")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send("{not valid json}");
    expect(res.status).toBe(400);
    // parseJsonBody shared utility uses INVALID_JSON for unparseable bodies
    expect(["INVALID_JSON", "INVALID_BODY"]).toContain(res.body.error);
  });
});

// ─── CA-21 : PUT name only (integration) ──────────────────────────────────────

describe("PUT /api/v1/quizzes/:id — CA-21 name only update", () => {
  it("CA-21: updates only the name without changing questions", async () => {
    const created = (await createValidQuiz()).body;
    const res = await request(server)
      .put(`/api/v1/quizzes/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ name: "Nouveau titre de quiz", question_ids: makeQ(10) });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Nouveau titre de quiz");
    expect(res.body.last_updated_at).not.toBeNull();
  });
});

// ─── CA-23 : Question list replaces old list entirely (integration) ────────────

describe("PUT /api/v1/quizzes/:id — CA-23 question list replaced", () => {
  it("CA-23: replaces question list entirely with new order", async () => {
    const created = (await createValidQuiz()).body;

    // Use questions 6-15 (reverse order) as the new list
    const newList = makeQ(15).slice(5).reverse();
    const res = await request(server)
      .put(`/api/v1/quizzes/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ name: created.name, question_ids: newList });
    expect(res.status).toBe(200);
    expect(res.body.question_count).toBe(10);
  });
});

// ─── CA-28 : PUT wrong Content-Type ────────────────────────────────────────────

describe("PUT /api/v1/quizzes/:id — CA-28 wrong Content-Type", () => {
  it("CA-28: returns 415 for non-JSON Content-Type on PUT", async () => {
    const created = (await createValidQuiz()).body;
    const res = await request(server)
      .put(`/api/v1/quizzes/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "text/plain")
      .send("not json");
    expect(res.status).toBe(415);
    expect(res.body.error).toBe("UNSUPPORTED_MEDIA_TYPE");
  });
});

// ─── CA-40 : Rate limiting → 429 ──────────────────────────────────────────────

describe("Rate limiting — CA-40", () => {
  it("CA-40: returns 429 on collection when rate limit exceeded", async () => {
    const limitedDb = openDatabase(":memory:");
    const limitedRateLimiter = new RateLimiter(2, 60_000);
    const limitedHandler = createQuizzesCollectionHandler(
      limitedDb, config,
      createAuthenticateMiddleware(JWT_SECRET),
      createAuthorizeMiddleware("admin"),
      limitedRateLimiter
    );
    const limitedServer = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost`);
      limitedHandler(req, res, url);
    });
    await new Promise((resolve) => limitedServer.listen(0, resolve));

    try {
      for (let i = 0; i < 2; i++) {
        await request(limitedServer).get("/api/v1/quizzes").set("Authorization", `Bearer ${makeToken()}`);
      }
      const res = await request(limitedServer).get("/api/v1/quizzes").set("Authorization", `Bearer ${makeToken()}`);
      expect(res.status).toBe(429);
      expect(res.body.error).toBe("RATE_LIMIT_EXCEEDED");
      expect(res.headers["retry-after"]).toBeDefined();
    } finally {
      limitedDb.close();
      await new Promise((resolve) => limitedServer.close(resolve));
    }
  });

  it("CA-40: returns 429 on resource when rate limit exceeded", async () => {
    const limitedDb = openDatabase(":memory:");
    const limitedRateLimiter = new RateLimiter(2, 60_000);
    const limitedHandler = createQuizResourceHandler(
      limitedDb, config,
      createAuthenticateMiddleware(JWT_SECRET),
      createAuthorizeMiddleware("admin"),
      limitedRateLimiter
    );
    const limitedServer = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost`);
      limitedHandler(req, res, url);
    });
    await new Promise((resolve) => limitedServer.listen(0, resolve));

    try {
      for (let i = 0; i < 2; i++) {
        await request(limitedServer)
          .put("/api/v1/quizzes/018e4f5a-8c3b-7d2e-9f1a-000000000099")
          .set("Authorization", `Bearer ${makeToken()}`)
          .set("Content-Type", "application/json")
          .send({ name: "Test", question_ids: makeQ(10) });
      }
      const res = await request(limitedServer)
        .put("/api/v1/quizzes/018e4f5a-8c3b-7d2e-9f1a-000000000099")
        .set("Authorization", `Bearer ${makeToken()}`)
        .set("Content-Type", "application/json")
        .send({ name: "Test", question_ids: makeQ(10) });
      expect(res.status).toBe(429);
      expect(res.body.error).toBe("RATE_LIMIT_EXCEEDED");
      expect(res.headers["retry-after"]).toBeDefined();
    } finally {
      limitedDb.close();
      await new Promise((resolve) => limitedServer.close(resolve));
    }
  });
});

// ─── CA-42 : Internal server error → 500 ──────────────────────────────────────

describe("CA-42 — Internal server error on quizzes", () => {
  it("CA-42: returns 500 on unexpected failure in collection handler", async () => {
    const Database = (await import("better-sqlite3")).default;
    const { createQuizzesCollectionHandler: brokenCollHandler } = await import("../../src/routes/quizRoute.js");

    const brokenDb = new Database(":memory:");
    brokenDb.close();

    const brokenHandler = brokenCollHandler(
      brokenDb, config,
      createAuthenticateMiddleware(JWT_SECRET),
      createAuthorizeMiddleware("admin"),
      new RateLimiter(100, 60_000)
    );
    const brokenServer = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost`);
      brokenHandler(req, res, url);
    });

    const res = await request(brokenServer)
      .get("/api/v1/quizzes")
      .set("Authorization", `Bearer ${makeToken()}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("INTERNAL_SERVER_ERROR");
  });
});
