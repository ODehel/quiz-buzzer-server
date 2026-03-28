import { createServer } from "node:http";
import { openDatabase } from "../../src/database/database.js";
import { createAuthenticateMiddleware } from "../../src/middlewares/authenticate.js";
import { createAuthorizeMiddleware } from "../../src/middlewares/authorize.js";
import { RateLimiter } from "../../src/middlewares/rateLimiter.js";
import {
  createGamesCollectionHandler,
  createGameResourceHandler,
} from "../../src/routes/gameRoute.js";
import jwt from "jsonwebtoken";
import request from "supertest";

const JWT_SECRET = "a".repeat(32);
const config = { jwtSecret: JWT_SECRET, jwtExpiration: 3600 };

const QUIZ_ID = "018e4f5c-0000-7000-8000-000000000001";
const QUIZ_ID_2 = "018e4f5c-0000-7000-8000-000000000002";

let db, server, adminToken, buzzerToken;

function makeToken(role = "admin") {
  return jwt.sign(
    { sub: "018e4f5a-8c3b-7d2e-9f1a-000000000001", role },
    JWT_SECRET,
    { algorithm: "HS256", expiresIn: 3600 }
  );
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach((done) => {
  db = openDatabase(":memory:");

  // Thème
  db.prepare(
    `INSERT INTO T_THEME_THM (THM_ID, THM_NAME, THM_CREATED_AT) VALUES (?, ?, ?)`
  ).run("thm-1", "Science", "2026-03-13T10:00:00.000Z");

  // Quiz
  db.prepare(
    `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT) VALUES (?, ?, ?)`
  ).run(QUIZ_ID, "Mon Quiz", "2026-03-13T10:00:00.000Z");
  db.prepare(
    `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT) VALUES (?, ?, ?)`
  ).run(QUIZ_ID_2, "Mon Deuxième Quiz", "2026-03-13T10:01:00.000Z");

  const authenticate = createAuthenticateMiddleware(JWT_SECRET);
  const authorize = createAuthorizeMiddleware("admin");
  const rateLimiter = new RateLimiter(100, 60_000);

  const collectionHandler = createGamesCollectionHandler(
    db, config, authenticate, authorize, rateLimiter
  );
  const resourceHandler = createGameResourceHandler(
    db, config, authenticate, authorize, rateLimiter
  );

  adminToken = makeToken("admin");
  buzzerToken = makeToken("buzzer");

  server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/v1/games") {
      collectionHandler(req, res, url);
    } else if (url.pathname.match(/^\/api\/v1\/games\/[^/]+$/)) {
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

async function createValidGame(quizId = QUIZ_ID, participants = ["Alice", "Bob", "Charlie"]) {
  return request(server)
    .post("/api/v1/games")
    .set("Authorization", `Bearer ${adminToken}`)
    .set("Content-Type", "application/json")
    .send({ quiz_id: quizId, participants });
}

async function getCreatedGameId() {
  const list = await request(server)
    .get("/api/v1/games")
    .set("Authorization", `Bearer ${adminToken}`);
  return list.body.data[0]?.id;
}

// ─── POST /api/v1/games ───────────────────────────────────────────────────────

describe("POST /api/v1/games", () => {
  it("CA-1: creates a game and returns 201 with the created game object", async () => {
    const res = await createValidGame();
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(res.body.status).toBe("PENDING");
    expect(res.body.quiz_id).toBe("018e4f5c-0000-7000-8000-000000000001");
    expect(res.body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(res.body.last_updated_at).toBeNull();
    expect(res.body.participants).toEqual([
      { order: 1, name: "Alice" },
      { order: 2, name: "Bob" },
      { order: 3, name: "Charlie" },
    ]);
  });

  it("CA-2 + CA-3 + CA-4: game has PENDING status, UUIDv7 id, ISO 8601 created_at", async () => {
    await createValidGame();
    const id = await getCreatedGameId();
    const res = await request(server)
      .get(`/api/v1/games/${id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PENDING");
    expect(res.body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(res.body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(res.body.last_updated_at).toBeNull();
  });

  it("CA-5: returns 400 INVALID_UUID for malformed quiz_id", async () => {
    const res = await request(server)
      .post("/api/v1/games")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ quiz_id: "not-a-uuid", participants: ["Alice"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_UUID");
  });

  it("CA-6: returns 404 QUIZ_NOT_FOUND for non-existent quiz_id", async () => {
    const res = await request(server)
      .post("/api/v1/games")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ quiz_id: "018e4f5c-0000-7000-8000-999999999999", participants: ["Alice"] });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("QUIZ_NOT_FOUND");
  });

  it("CA-7: returns 409 ACTIVE_GAME_EXISTS when a game is PENDING", async () => {
    await createValidGame();
    const res = await createValidGame(QUIZ_ID_2, ["Bob"]);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("ACTIVE_GAME_EXISTS");
    expect(res.body.message).toBe(
      "A game is already active. Delete it before creating a new one."
    );
  });

  it("CA-7: returns 409 ACTIVE_GAME_EXISTS when a game is OPEN", async () => {
    await createValidGame();
    const id = await getCreatedGameId();
    // Move to OPEN
    await request(server)
      .put(`/api/v1/games/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ status: "OPEN", participants: ["Alice"] });
    const res = await createValidGame(QUIZ_ID_2, ["Bob"]);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("ACTIVE_GAME_EXISTS");
  });

  it("CA-7: allows creation after COMPLETED game", async () => {
    await createValidGame();
    const id = await getCreatedGameId();
    // Move to OPEN then COMPLETED
    await request(server)
      .put(`/api/v1/games/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ status: "OPEN", participants: ["Alice"] });
    await request(server)
      .put(`/api/v1/games/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ status: "COMPLETED", participants: ["Alice"] });
    const res = await createValidGame(QUIZ_ID_2, ["Bob"]);
    expect(res.status).toBe(201);
  });

  it("CA-8: returns 400 for empty participants array", async () => {
    const res = await request(server)
      .post("/api/v1/games")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ quiz_id: QUIZ_ID, participants: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  it("CA-8: returns 400 for more than 10 participants", async () => {
    const res = await request(server)
      .post("/api/v1/games")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ quiz_id: QUIZ_ID, participants: Array.from({ length: 11 }, (_, i) => `Player${i}`) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  it("CA-9: returns 400 for participant name longer than 50 chars", async () => {
    const res = await request(server)
      .post("/api/v1/games")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ quiz_id: QUIZ_ID, participants: ["A".repeat(51)] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  it("CA-9: returns 400 for empty participant name", async () => {
    const res = await request(server)
      .post("/api/v1/games")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ quiz_id: QUIZ_ID, participants: [""] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  it("CA-9a: returns 400 for duplicate participant names", async () => {
    const res = await request(server)
      .post("/api/v1/games")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ quiz_id: QUIZ_ID, participants: ["Alice", "Bob", "Alice"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
    expect(res.body.message).toContain("not unique");
  });

  it("CA-10: participants have 1-based order", async () => {
    await createValidGame(QUIZ_ID, ["Alice", "Bob", "Charlie"]);
    const id = await getCreatedGameId();
    const res = await request(server)
      .get(`/api/v1/games/${id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.body.participants).toEqual([
      { order: 1, name: "Alice" },
      { order: 2, name: "Bob" },
      { order: 3, name: "Charlie" },
    ]);
  });

  it("CA-11: returns 400 UNKNOWN_FIELDS for extra fields", async () => {
    const res = await request(server)
      .post("/api/v1/games")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ quiz_id: QUIZ_ID, participants: ["Alice"], extra: "field" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("UNKNOWN_FIELDS");
  });

  it("CA-12: returns 415 for wrong Content-Type", async () => {
    const res = await request(server)
      .post("/api/v1/games")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "text/plain")
      .send("hello");
    expect(res.status).toBe(415);
    expect(res.body.error).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("CA-13: returns 400 for non-parseable body", async () => {
    const res = await request(server)
      .post("/api/v1/games")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send("not valid json{{{");
    expect(res.status).toBe(400);
  });

  it("CA-14: returns 400 when quiz_id is missing", async () => {
    const res = await request(server)
      .post("/api/v1/games")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ participants: ["Alice"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  it("CA-14: returns 400 when participants is missing", async () => {
    const res = await request(server)
      .post("/api/v1/games")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ quiz_id: QUIZ_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });
});

// ─── GET /api/v1/games ────────────────────────────────────────────────────────

describe("GET /api/v1/games", () => {
  it("CA-15: returns 200 with list of games", async () => {
    await createValidGame();
    const res = await request(server)
      .get("/api/v1/games")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(1);
    expect(res.body).toHaveProperty("page", 1);
    expect(res.body).toHaveProperty("limit", 20);
    expect(res.body).toHaveProperty("total", 1);
    expect(res.body).toHaveProperty("total_pages", 1);
  });

  it("CA-16: returns 200 with empty array when no games", async () => {
    const res = await request(server)
      .get("/api/v1/games")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.total_pages).toBe(0);
  });

  it("CA-17: returns games sorted by created_at descending", async () => {
    // Insert games directly with different timestamps
    db.prepare(
      `INSERT INTO T_GAME_GAM (GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT) VALUES (?, ?, 'PENDING', ?)`
    ).run("game-old-1111-1111-1111-111111111111", QUIZ_ID, "2026-03-13T10:00:00.000Z");
    db.prepare(
      `INSERT INTO T_GAME_GAM (GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT) VALUES (?, ?, 'COMPLETED', ?)`
    ).run("game-new-2222-2222-2222-222222222222", QUIZ_ID_2, "2026-03-14T10:00:00.000Z");

    const res = await request(server)
      .get("/api/v1/games")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].created_at > res.body.data[1].created_at).toBe(true);
  });

  it("CA-18: each game contains all required fields", async () => {
    await createValidGame(QUIZ_ID, ["Alice", "Bob"]);
    const res = await request(server)
      .get("/api/v1/games")
      .set("Authorization", `Bearer ${adminToken}`);
    const game = res.body.data[0];
    expect(game).toHaveProperty("id");
    expect(game).toHaveProperty("quiz_id", QUIZ_ID);
    expect(game).toHaveProperty("status", "PENDING");
    expect(game).toHaveProperty("created_at");
    expect(game).toHaveProperty("participants");
    expect(game.participants).toEqual([
      { order: 1, name: "Alice" },
      { order: 2, name: "Bob" },
    ]);
  });
});

// ─── GET /api/v1/games/:id ────────────────────────────────────────────────────

describe("GET /api/v1/games/:id", () => {
  it("CA-19: returns 200 with game by id", async () => {
    await createValidGame(QUIZ_ID, ["Alice"]);
    const id = await getCreatedGameId();
    const res = await request(server)
      .get(`/api/v1/games/${id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.quiz_id).toBe(QUIZ_ID);
    expect(res.body.status).toBe("PENDING");
    expect(res.body.participants).toEqual([{ order: 1, name: "Alice" }]);
  });

  it("CA-20: returns 404 for non-existent id", async () => {
    const res = await request(server)
      .get("/api/v1/games/018e4f5d-0000-7000-8000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NOT_FOUND");
  });

  it("CA-21: returns 400 INVALID_UUID for malformed id", async () => {
    const res = await request(server)
      .get("/api/v1/games/not-a-valid-uuid")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_UUID");
  });
});

// ─── PUT /api/v1/games/:id ────────────────────────────────────────────────────

describe("PUT /api/v1/games/:id", () => {
  let gameId;
  beforeEach(async () => {
    await createValidGame(QUIZ_ID, ["Alice", "Bob", "Charlie"]);
    gameId = await getCreatedGameId();
  });

  it("CA-22: updates participants and returns 200", async () => {
    const res = await request(server)
      .put(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ participants: ["Alice", "Robert"] });
    expect(res.status).toBe(200);
    expect(res.body.participants).toEqual([
      { order: 1, name: "Alice" },
      { order: 2, name: "Robert" },
    ]);
    // Verify last_updated_at is set after PUT
    expect(res.body.last_updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("CA-23 + CA-25: transitions PENDING -> OPEN and returns 200", async () => {
    const res = await request(server)
      .put(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ status: "OPEN", participants: ["Alice", "Bob", "Charlie"] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("OPEN");
    // Verify last_updated_at is set after PUT
    expect(res.body.last_updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("CA-24: returns 400 IMMUTABLE_FIELD when quiz_id differs", async () => {
    const res = await request(server)
      .put(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ quiz_id: QUIZ_ID_2, participants: ["Alice"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("IMMUTABLE_FIELD");
    expect(res.body.message).toBe("quiz_id cannot be changed after creation.");
  });

  it("CA-24: accepts quiz_id if it matches current", async () => {
    const res = await request(server)
      .put(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ quiz_id: QUIZ_ID, participants: ["Alice"] });
    expect(res.status).toBe(200);
  });

  it("CA-25: transitions OPEN -> COMPLETED", async () => {
    // First move to OPEN
    await request(server)
      .put(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ status: "OPEN", participants: ["Alice"] });

    const res = await request(server)
      .put(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ status: "COMPLETED", participants: ["Alice"] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("COMPLETED");
  });

  it("CA-26: returns 422 for PENDING -> COMPLETED transition", async () => {
    const res = await request(server)
      .put(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ status: "COMPLETED", participants: ["Alice"] });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("INVALID_TRANSITION");
    expect(res.body.message).toContain("PENDING");
    expect(res.body.message).toContain("COMPLETED");
  });

  it("CA-27: returns 422 for any transition from COMPLETED", async () => {
    // Move to COMPLETED via OPEN
    await request(server)
      .put(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ status: "OPEN", participants: ["Alice"] });
    await request(server)
      .put(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ status: "COMPLETED", participants: ["Alice"] });

    const res = await request(server)
      .put(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ status: "OPEN", participants: ["Alice"] });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("INVALID_TRANSITION");
  });

  it("CA-28: returns 422 when trying to transition to IN_ERROR via PUT", async () => {
    const res = await request(server)
      .put(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ status: "IN_ERROR", participants: ["Alice"] });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("INVALID_TRANSITION");
  });

  it("CA-29: returns 422 for any transition from IN_ERROR", async () => {
    // Force IN_ERROR status directly in DB
    db.prepare(`UPDATE T_GAME_GAM SET GAM_STATUS = 'IN_ERROR' WHERE GAM_ID = ?`).run(gameId);

    const res = await request(server)
      .put(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ status: "OPEN", participants: ["Alice"] });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("INVALID_TRANSITION");
  });

  it("CA-30: PUT replaces participants entirely", async () => {
    await request(server)
      .put(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ participants: ["New1", "New2"] });

    const res = await request(server)
      .get(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.body.participants).toEqual([
      { order: 1, name: "New1" },
      { order: 2, name: "New2" },
    ]);
    expect(res.body.participants.length).toBe(2);
  });

  it("CA-31: returns 400 for invalid participants in PUT", async () => {
    const res = await request(server)
      .put(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ participants: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  it("CA-9a: returns 400 for duplicate participant names in PUT", async () => {
    const res = await request(server)
      .put(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ participants: ["Alice", "Bob", "Alice"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
    expect(res.body.message).toContain("not unique");
  });

  it("CA-32: returns 400 UNKNOWN_FIELDS for extra body fields", async () => {
    const res = await request(server)
      .put(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ participants: ["Alice"], unknown_field: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("UNKNOWN_FIELDS");
  });

  it("CA-33: returns 404 for non-existent game id", async () => {
    const res = await request(server)
      .put("/api/v1/games/018e4f5d-0000-7000-8000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ participants: ["Alice"] });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NOT_FOUND");
  });

  it("CA-34: returns 400 INVALID_UUID for malformed id", async () => {
    const res = await request(server)
      .put("/api/v1/games/invalid-id")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ participants: ["Alice"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_UUID");
  });

  it("CA-35: returns 415 for wrong Content-Type on PUT", async () => {
    const res = await request(server)
      .put(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "text/plain")
      .send("hello");
    expect(res.status).toBe(415);
    expect(res.body.error).toBe("UNSUPPORTED_MEDIA_TYPE");
  });
});

// ─── PATCH /api/v1/games/:id ──────────────────────────────────────────────────

describe("PATCH /api/v1/games/:id", () => {
  let gameId;
  beforeEach(async () => {
    await createValidGame(QUIZ_ID, ["Alice", "Bob", "Charlie"]);
    gameId = await getCreatedGameId();
  });

  it("CA-36: updates status alone and returns 200", async () => {
    const res = await request(server)
      .patch(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ status: "OPEN" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("OPEN");
    // Participants unchanged
    expect(res.body.participants.length).toBe(3);
    // Verify last_updated_at is set after PATCH
    expect(res.body.last_updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("CA-37: renames a single participant and returns 200", async () => {
    const res = await request(server)
      .patch(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ participants: [{ order: 2, name: "Robert" }] });
    expect(res.status).toBe(200);
    expect(res.body.participants).toEqual([
      { order: 1, name: "Alice" },
      { order: 2, name: "Robert" },
      { order: 3, name: "Charlie" },
    ]);
    // Verify last_updated_at is set after PATCH
    expect(res.body.last_updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("CA-38: returns 404 PARTICIPANT_NOT_FOUND for non-existent order", async () => {
    const res = await request(server)
      .patch(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ participants: [{ order: 9, name: "Robert" }] });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("PARTICIPANT_NOT_FOUND");
    expect(res.body.message).toContain("9");
  });

  it("CA-39: returns 400 for invalid order (out of range)", async () => {
    const res = await request(server)
      .patch(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ participants: [{ order: 11, name: "Robert" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  it("CA-39: returns 400 for non-integer order", async () => {
    const res = await request(server)
      .patch(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ participants: [{ order: 1.5, name: "Robert" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  it("CA-40: returns 400 for participant name too long in PATCH", async () => {
    const res = await request(server)
      .patch(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ participants: [{ order: 1, name: "A".repeat(51) }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  it("CA-9a: returns 400 for duplicate participant name in PATCH (conflicting with existing)", async () => {
    const res = await request(server)
      .patch(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ participants: [{ order: 1, name: "Bob" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
    expect(res.body.message).toContain("not unique");
  });

  it("CA-9a: returns 400 for duplicate participant names in PATCH (within patches)", async () => {
    const res = await request(server)
      .patch(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({
        participants: [
          { order: 1, name: "NewName" },
          { order: 2, name: "NewName" },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
    expect(res.body.message).toContain("not unique");
  });

  it("CA-41: returns 400 IMMUTABLE_FIELD when quiz_id differs in PATCH", async () => {
    const res = await request(server)
      .patch(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ quiz_id: QUIZ_ID_2 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("IMMUTABLE_FIELD");
  });

  it("CA-42: PATCH respects status transition rules", async () => {
    const res = await request(server)
      .patch(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ status: "COMPLETED" });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("INVALID_TRANSITION");
  });

  it("CA-43: returns 400 UNKNOWN_FIELDS for extra fields in PATCH", async () => {
    const res = await request(server)
      .patch(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ unknown: "field" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("UNKNOWN_FIELDS");
  });

  it("CA-44: returns 404 for non-existent id in PATCH", async () => {
    const res = await request(server)
      .patch("/api/v1/games/018e4f5d-0000-7000-8000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ status: "OPEN" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NOT_FOUND");
  });

  it("CA-45: returns 400 INVALID_UUID for malformed id in PATCH", async () => {
    const res = await request(server)
      .patch("/api/v1/games/bad-id")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ status: "OPEN" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_UUID");
  });

  it("CA-46: returns 415 for wrong Content-Type in PATCH", async () => {
    const res = await request(server)
      .patch(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "text/plain")
      .send("hello");
    expect(res.status).toBe(415);
    expect(res.body.error).toBe("UNSUPPORTED_MEDIA_TYPE");
  });
});

// ─── DELETE /api/v1/games/:id ─────────────────────────────────────────────────

describe("DELETE /api/v1/games/:id", () => {
  let gameId;
  beforeEach(async () => {
    await createValidGame(QUIZ_ID, ["Alice", "Bob"]);
    gameId = await getCreatedGameId();
  });

  it("CA-47: deletes game and returns 204", async () => {
    const res = await request(server)
      .delete(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(204);
    expect(res.text).toBe("");
  });

  it("CA-48: participants are deleted in cascade", async () => {
    await request(server)
      .delete(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const count = db
      .prepare(`SELECT COUNT(*) AS count FROM T_GAME_PARTICIPANT_GPA WHERE GPA_GAME_ID = ?`)
      .get(gameId).count;
    expect(count).toBe(0);
  });

  it("CA-49: returns 404 for non-existent id", async () => {
    const res = await request(server)
      .delete("/api/v1/games/018e4f5d-0000-7000-8000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NOT_FOUND");
  });

  it("CA-50: returns 400 INVALID_UUID for malformed id", async () => {
    const res = await request(server)
      .delete("/api/v1/games/not-an-id")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_UUID");
  });

  it("CA-51: body on DELETE is ignored silently", async () => {
    const res = await request(server)
      .delete(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ extra: "data" });
    expect(res.status).toBe(204);
  });

  it("Point de vigilance US-010: deletion of active game (OPEN state) cleans up orchestrator state", async () => {
    // Transition game to OPEN state to simulate an active game
    await request(server)
      .put(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({ status: "OPEN", participants: ["Alice", "Bob"] });

    // Delete the active game — should cleanup timers before SQL deletion
    const res = await request(server)
      .delete(`/api/v1/games/${gameId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(204);

    // Verify game is deleted from database
    const deletedGame = db.prepare("SELECT * FROM T_GAME_GAM WHERE GAM_ID = ?").get(gameId);
    expect(deletedGame).toBeUndefined();

    // Verify participants are cascaded deleted
    const participantCount = db.prepare(
      "SELECT COUNT(*) AS count FROM T_GAME_PARTICIPANT_GPA WHERE GPA_GAME_ID = ?"
    ).get(gameId).count;
    expect(participantCount).toBe(0);
  });
});

// ─── Sécurité et transversalité ───────────────────────────────────────────────

describe("Security — CA-52 to CA-56", () => {
  it("CA-52: returns 401 without token on collection", async () => {
    const res = await request(server).get("/api/v1/games");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("UNAUTHORIZED");
  });

  it("CA-52: returns 401 without token on resource", async () => {
    const res = await request(server).get("/api/v1/games/018e4f5d-0000-7000-8000-000000000000");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("UNAUTHORIZED");
  });

  it("CA-52: returns 401 with expired token", async () => {
    const expiredToken = jwt.sign(
      { sub: "018e4f5a-8c3b-7d2e-9f1a-000000000001", role: "admin" },
      JWT_SECRET,
      { algorithm: "HS256", expiresIn: -1 }
    );
    const res = await request(server)
      .get("/api/v1/games")
      .set("Authorization", `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
  });

  it("CA-53: returns 403 for buzzer role", async () => {
    const res = await request(server)
      .get("/api/v1/games")
      .set("Authorization", `Bearer ${buzzerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("FORBIDDEN");
  });

  it("CA-54: returns 429 when rate limit exceeded on collection", async () => {
    const authenticate = createAuthenticateMiddleware(JWT_SECRET);
    const authorize = createAuthorizeMiddleware("admin");
    const tightLimiter = new RateLimiter(1, 60_000);
    const handler = createGamesCollectionHandler(db, config, authenticate, authorize, tightLimiter);

    const limitServer = createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname === "/api/v1/games") handler(req, res);
    });
    await new Promise((resolve) => limitServer.listen(0, resolve));

    // Consume the 1 allowed request
    await request(limitServer).get("/api/v1/games").set("Authorization", `Bearer ${adminToken}`);
    const res = await request(limitServer)
      .get("/api/v1/games")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("RATE_LIMIT_EXCEEDED");
    expect(res.headers["retry-after"]).toBeDefined();

    await new Promise((resolve) => limitServer.close(resolve));
  });

  it("CA-54: returns 429 when rate limit exceeded on resource", async () => {
    const authenticate = createAuthenticateMiddleware(JWT_SECRET);
    const authorize = createAuthorizeMiddleware("admin");
    const tightLimiter = new RateLimiter(1, 60_000);
    const handler = createGameResourceHandler(db, config, authenticate, authorize, tightLimiter);

    const limitServer = createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname.match(/^\/api\/v1\/games\/[^/]+$/)) handler(req, res, url);
    });
    await new Promise((resolve) => limitServer.listen(0, resolve));

    await request(limitServer)
      .get("/api/v1/games/018e4f5d-0000-7000-8000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    const res = await request(limitServer)
      .get("/api/v1/games/018e4f5d-0000-7000-8000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("RATE_LIMIT_EXCEEDED");

    await new Promise((resolve) => limitServer.close(resolve));
  });

  it("CA-55: returns 405 for unsupported method on collection (Allow: GET, POST)", async () => {
    const res = await request(server)
      .patch("/api/v1/games")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({});
    expect(res.status).toBe(405);
    expect(res.body.error).toBe("METHOD_NOT_ALLOWED");
    expect(res.headers["allow"]).toBe("GET, POST");
  });

  it("CA-55: returns 405 for unsupported method on resource (Allow: GET, PUT, PATCH, DELETE)", async () => {
    const res = await request(server)
      .post("/api/v1/games/018e4f5d-0000-7000-8000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({});
    expect(res.status).toBe(405);
    expect(res.body.error).toBe("METHOD_NOT_ALLOWED");
    expect(res.headers["allow"]).toBe("GET, PUT, PATCH, DELETE");
  });

  it("CA-56: returns 500 on unexpected error", async () => {
    const brokenDb = { prepare: () => { throw new Error("DB exploded"); } };
    const authenticate = createAuthenticateMiddleware(JWT_SECRET);
    const authorize = createAuthorizeMiddleware("admin");
    const handler = createGamesCollectionHandler(
      brokenDb, config, authenticate, authorize, new RateLimiter(100, 60_000)
    );
    const errServer = createServer((req, res) => {
      if (req.url === "/api/v1/games") handler(req, res);
    });
    await new Promise((resolve) => errServer.listen(0, resolve));

    const res = await request(errServer)
      .get("/api/v1/games")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("INTERNAL_SERVER_ERROR");

    await new Promise((resolve) => errServer.close(resolve));
  });
});
