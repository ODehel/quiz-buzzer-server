import { createServer } from "node:http";
import { openDatabase } from "../src/database/database.js";
import { createAuthenticateMiddleware } from "../src/middlewares/authenticate.js";
import { createAuthorizeMiddleware } from "../src/middlewares/authorize.js";
import { RateLimiter } from "../src/middlewares/rateLimiter.js";
import { createGameResultsHandler } from "../src/routes/gameRoute.js";
import jwt from "jsonwebtoken";
import request from "supertest";

const JWT_SECRET = "a".repeat(32);
const config = { jwtSecret: JWT_SECRET, jwtExpiration: 3600 };

const GAME_ID = "018e4f5d-0000-7000-8000-000000000001";
const QUIZ_ID = "018e4f5c-0000-7000-8000-000000000001";
const QUESTION_ID_1 = "018e4f5b-0000-7000-8000-000000000001";
const QUESTION_ID_2 = "018e4f5b-0000-7000-8000-000000000002";

let db, server, adminToken, buzzerToken;

function makeToken(role = "admin") {
  return jwt.sign(
    { sub: "018e4f5a-8c3b-7d2e-9f1a-000000000001", role },
    JWT_SECRET,
    { algorithm: "HS256", expiresIn: 3600 }
  );
}

function seedCompletedGame() {
  // Theme + Questions (FK dependencies)
  db.prepare(
    `INSERT INTO T_THEME_THM (THM_ID, THM_NAME, THM_CREATED_AT) VALUES (?, ?, ?)`
  ).run("thm-1", "Science", "2026-03-13T09:00:00.000Z");
  db.prepare(
    `INSERT INTO T_QUESTION_QST (QST_ID, QST_TITLE, QST_TYPE, QST_THEME_ID, QST_LEVEL, QST_TIME_LIMIT, QST_POINTS, QST_CORRECT_ANSWER, QST_CHOICE_A, QST_CHOICE_B, QST_CHOICE_C, QST_CHOICE_D, QST_CREATED_AT)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(QUESTION_ID_1, "Question 1", "MCQ", "thm-1", 1, 30, 10, "A", "Opt A", "Opt B", "Opt C", "Opt D", "2026-03-13T09:00:00.000Z");
  db.prepare(
    `INSERT INTO T_QUESTION_QST (QST_ID, QST_TITLE, QST_TYPE, QST_THEME_ID, QST_LEVEL, QST_TIME_LIMIT, QST_POINTS, QST_CORRECT_ANSWER, QST_CHOICE_A, QST_CHOICE_B, QST_CHOICE_C, QST_CHOICE_D, QST_CREATED_AT)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(QUESTION_ID_2, "Question 2", "MCQ", "thm-1", 1, 30, 10, "D", "Opt A", "Opt B", "Opt C", "Opt D", "2026-03-13T09:00:00.000Z");

  db.prepare(
    `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT) VALUES (?, ?, ?)`
  ).run(QUIZ_ID, "Mon Quiz", "2026-03-13T10:00:00.000Z");

  db.prepare(
    `INSERT INTO T_GAME_GAM (GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT) VALUES (?, ?, 'COMPLETED', ?)`
  ).run(GAME_ID, QUIZ_ID, "2026-03-13T10:00:00.000Z");

  db.prepare(
    `INSERT INTO T_GAME_PARTICIPANT_GPA (GPA_GAME_ID, GPA_NAME, GPA_ORDER) VALUES (?, ?, ?)`
  ).run(GAME_ID, "Alice", 1);
  db.prepare(
    `INSERT INTO T_GAME_PARTICIPANT_GPA (GPA_GAME_ID, GPA_NAME, GPA_ORDER) VALUES (?, ?, ?)`
  ).run(GAME_ID, "Bob", 2);

  // Question 1 answers
  db.prepare(
    `INSERT INTO T_GAME_ANSWER_GAA (GAA_ID, GAA_GAME_ID, GAA_QUESTION_ID, GAA_PARTICIPANT_ORDER, GAA_ANSWER, GAA_TIME_MS, GAA_POINTS_EARNED, GAA_CUMULATIVE_SCORE, GAA_CREATED_AT)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("ans-1", GAME_ID, QUESTION_ID_1, 1, "A", 3200, 10, 10, "2026-03-13T10:01:00.000Z");
  db.prepare(
    `INSERT INTO T_GAME_ANSWER_GAA (GAA_ID, GAA_GAME_ID, GAA_QUESTION_ID, GAA_PARTICIPANT_ORDER, GAA_ANSWER, GAA_TIME_MS, GAA_POINTS_EARNED, GAA_CUMULATIVE_SCORE, GAA_CREATED_AT)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("ans-2", GAME_ID, QUESTION_ID_1, 2, "B", 5000, 0, 0, "2026-03-13T10:01:01.000Z");

  // Question 2 answers
  db.prepare(
    `INSERT INTO T_GAME_ANSWER_GAA (GAA_ID, GAA_GAME_ID, GAA_QUESTION_ID, GAA_PARTICIPANT_ORDER, GAA_ANSWER, GAA_TIME_MS, GAA_POINTS_EARNED, GAA_CUMULATIVE_SCORE, GAA_CREATED_AT)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("ans-3", GAME_ID, QUESTION_ID_2, 1, "C", 4000, 0, 10, "2026-03-13T10:02:00.000Z");
  db.prepare(
    `INSERT INTO T_GAME_ANSWER_GAA (GAA_ID, GAA_GAME_ID, GAA_QUESTION_ID, GAA_PARTICIPANT_ORDER, GAA_ANSWER, GAA_TIME_MS, GAA_POINTS_EARNED, GAA_CUMULATIVE_SCORE, GAA_CREATED_AT)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("ans-4", GAME_ID, QUESTION_ID_2, 2, "D", 2100, 10, 10, "2026-03-13T10:02:01.000Z");
}

beforeEach((done) => {
  db = openDatabase(":memory:");
  adminToken = makeToken("admin");
  buzzerToken = makeToken("buzzer");

  const authenticate = createAuthenticateMiddleware(JWT_SECRET);
  const authorize = createAuthorizeMiddleware("admin");
  const rateLimiter = new RateLimiter(100, 60_000);

  const resultsHandler = createGameResultsHandler(
    db, config, authenticate, authorize, rateLimiter
  );

  server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.match(/^\/api\/v1\/games\/[^/]+\/results$/)) {
      resultsHandler(req, res, url);
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

// ─── GET /api/v1/games/:id/results ─────────────────────────────────────────────

describe("GET /api/v1/games/:id/results", () => {
  it("returns 200 with ranking and question details for a completed game", async () => {
    seedCompletedGame();

    const res = await request(server)
      .get(`/api/v1/games/${GAME_ID}/results`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.game_id).toBe(GAME_ID);
    expect(res.body.quiz_id).toBe(QUIZ_ID);
    expect(res.body.status).toBe("COMPLETED");

    // Ranking: both 10pts, but Bob faster (7100ms vs 7200ms) → Bob rank 1
    expect(res.body.ranking).toHaveLength(2);
    expect(res.body.ranking[0]).toMatchObject({ rank: 1, name: "Bob", score: 10, total_time_ms: 7100 });
    expect(res.body.ranking[1]).toMatchObject({ rank: 2, name: "Alice", score: 10, total_time_ms: 7200 });

    // Questions
    expect(res.body.questions).toHaveLength(2);
    expect(res.body.questions[0].question_id).toBe(QUESTION_ID_1);
    expect(res.body.questions[0].answers).toHaveLength(2);
    expect(res.body.questions[1].question_id).toBe(QUESTION_ID_2);

    // CA-6: each answer contains all required fields
    const firstAnswer = res.body.questions[0].answers[0];
    expect(firstAnswer).toMatchObject({
      participant_order: 1,
      answer: "A",
      time_ms: 3200,
      points_earned: 10,
      cumulative_score: 10,
    });
  });

  it("returns 409 GAME_NOT_COMPLETED for a PENDING game", async () => {
    db.prepare(
      `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT) VALUES (?, ?, ?)`
    ).run(QUIZ_ID, "Mon Quiz", "2026-03-13T10:00:00.000Z");
    db.prepare(
      `INSERT INTO T_GAME_GAM (GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT) VALUES (?, ?, 'PENDING', ?)`
    ).run(GAME_ID, QUIZ_ID, "2026-03-13T10:00:00.000Z");

    const res = await request(server)
      .get(`/api/v1/games/${GAME_ID}/results`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("GAME_NOT_COMPLETED");
  });

  it("returns 409 GAME_NOT_COMPLETED for an OPEN game", async () => {
    db.prepare(
      `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT) VALUES (?, ?, ?)`
    ).run(QUIZ_ID, "Mon Quiz", "2026-03-13T10:00:00.000Z");
    db.prepare(
      `INSERT INTO T_GAME_GAM (GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT) VALUES (?, ?, 'OPEN', ?)`
    ).run(GAME_ID, QUIZ_ID, "2026-03-13T10:00:00.000Z");

    const res = await request(server)
      .get(`/api/v1/games/${GAME_ID}/results`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("GAME_NOT_COMPLETED");
  });

  it("returns 404 NOT_FOUND for a non-existent game", async () => {
    const res = await request(server)
      .get(`/api/v1/games/${GAME_ID}/results`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NOT_FOUND");
  });

  it("returns 400 INVALID_UUID for a malformed ID", async () => {
    const res = await request(server)
      .get("/api/v1/games/not-a-uuid/results")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_UUID");
  });

  it("returns 401 UNAUTHORIZED without a token", async () => {
    const res = await request(server)
      .get(`/api/v1/games/${GAME_ID}/results`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("UNAUTHORIZED");
  });

  it("returns 403 FORBIDDEN for a buzzer role", async () => {
    const res = await request(server)
      .get(`/api/v1/games/${GAME_ID}/results`)
      .set("Authorization", `Bearer ${buzzerToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("FORBIDDEN");
  });

  it("returns 405 METHOD_NOT_ALLOWED for POST", async () => {
    const res = await request(server)
      .post(`/api/v1/games/${GAME_ID}/results`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "application/json")
      .send({});

    expect(res.status).toBe(405);
    expect(res.body.error).toBe("METHOD_NOT_ALLOWED");
    expect(res.headers.allow).toBe("GET");
  });

  it("ranks by score first, then by total time ascending for tiebreakers", async () => {
    // Setup: 3 participants
    // Alice: 20pts, 8000ms total
    // Bob:   10pts, 3000ms total (fewer points but very fast)
    // Charlie: 20pts, 6000ms total (same score as Alice but faster)
    db.prepare(
      `INSERT INTO T_THEME_THM (THM_ID, THM_NAME, THM_CREATED_AT) VALUES (?, ?, ?)`
    ).run("thm-1", "Science", "2026-03-13T09:00:00.000Z");
    db.prepare(
      `INSERT INTO T_QUESTION_QST (QST_ID, QST_TITLE, QST_TYPE, QST_THEME_ID, QST_LEVEL, QST_TIME_LIMIT, QST_POINTS, QST_CORRECT_ANSWER, QST_CHOICE_A, QST_CHOICE_B, QST_CHOICE_C, QST_CHOICE_D, QST_CREATED_AT)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(QUESTION_ID_1, "Q1", "MCQ", "thm-1", 1, 30, 10, "A", "A", "B", "C", "D", "2026-03-13T09:00:00.000Z");
    db.prepare(
      `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT) VALUES (?, ?, ?)`
    ).run(QUIZ_ID, "Quiz", "2026-03-13T10:00:00.000Z");
    db.prepare(
      `INSERT INTO T_GAME_GAM (GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT) VALUES (?, ?, 'COMPLETED', ?)`
    ).run(GAME_ID, QUIZ_ID, "2026-03-13T10:00:00.000Z");
    db.prepare(`INSERT INTO T_GAME_PARTICIPANT_GPA (GPA_GAME_ID, GPA_NAME, GPA_ORDER) VALUES (?, ?, ?)`).run(GAME_ID, "Alice", 1);
    db.prepare(`INSERT INTO T_GAME_PARTICIPANT_GPA (GPA_GAME_ID, GPA_NAME, GPA_ORDER) VALUES (?, ?, ?)`).run(GAME_ID, "Bob", 2);
    db.prepare(`INSERT INTO T_GAME_PARTICIPANT_GPA (GPA_GAME_ID, GPA_NAME, GPA_ORDER) VALUES (?, ?, ?)`).run(GAME_ID, "Charlie", 3);

    const insertAnswer = db.prepare(
      `INSERT INTO T_GAME_ANSWER_GAA (GAA_ID, GAA_GAME_ID, GAA_QUESTION_ID, GAA_PARTICIPANT_ORDER, GAA_ANSWER, GAA_TIME_MS, GAA_POINTS_EARNED, GAA_CUMULATIVE_SCORE, GAA_CREATED_AT)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertAnswer.run("a1", GAME_ID, QUESTION_ID_1, 1, "A", 8000, 20, 20, "2026-03-13T10:01:00.000Z");
    insertAnswer.run("a2", GAME_ID, QUESTION_ID_1, 2, "B", 3000, 10, 10, "2026-03-13T10:01:01.000Z");
    insertAnswer.run("a3", GAME_ID, QUESTION_ID_1, 3, "A", 6000, 20, 20, "2026-03-13T10:01:02.000Z");

    const res = await request(server)
      .get(`/api/v1/games/${GAME_ID}/results`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    // Charlie (20pts, 6000ms) beats Alice (20pts, 8000ms) on time; Bob (10pts) is last
    expect(res.body.ranking[0]).toMatchObject({ rank: 1, name: "Charlie", score: 20, total_time_ms: 6000 });
    expect(res.body.ranking[1]).toMatchObject({ rank: 2, name: "Alice", score: 20, total_time_ms: 8000 });
    expect(res.body.ranking[2]).toMatchObject({ rank: 3, name: "Bob", score: 10, total_time_ms: 3000 });
  });

  it("returns 429 RATE_LIMIT_EXCEEDED when rate limit is exceeded", async () => {
    // Close default server and create one with a very low rate limit
    await new Promise((resolve) => server.close(resolve));

    const authenticate = createAuthenticateMiddleware(JWT_SECRET);
    const authorize = createAuthorizeMiddleware("admin");
    const tightLimiter = new RateLimiter(1, 60_000);

    const resultsHandler = createGameResultsHandler(
      db, config, authenticate, authorize, tightLimiter
    );

    server = createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname.match(/^\/api\/v1\/games\/[^/]+\/results$/)) {
        resultsHandler(req, res, url);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, resolve));

    // First request consumes the single allowed request
    await request(server)
      .get(`/api/v1/games/${GAME_ID}/results`)
      .set("Authorization", `Bearer ${adminToken}`);

    // Second request should be rate limited
    const res = await request(server)
      .get(`/api/v1/games/${GAME_ID}/results`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("RATE_LIMIT_EXCEEDED");
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("returns 500 INTERNAL_SERVER_ERROR on unexpected error", async () => {
    // Close the DB to trigger an unexpected error
    db.close();

    const res = await request(server)
      .get(`/api/v1/games/${GAME_ID}/results`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("INTERNAL_SERVER_ERROR");
    expect(res.body.message).toBe("An unexpected error occurred. Please try again later.");

    // Reopen DB so afterEach cleanup doesn't fail
    db = openDatabase(":memory:");
  });

  it("returns 200 with empty ranking when game has no answers", async () => {
    db.prepare(
      `INSERT INTO T_QUIZ_QUZ (QUZ_ID, QUZ_NAME, QUZ_CREATED_AT) VALUES (?, ?, ?)`
    ).run(QUIZ_ID, "Mon Quiz", "2026-03-13T10:00:00.000Z");
    db.prepare(
      `INSERT INTO T_GAME_GAM (GAM_ID, GAM_QUIZ_ID, GAM_STATUS, GAM_CREATED_AT) VALUES (?, ?, 'COMPLETED', ?)`
    ).run(GAME_ID, QUIZ_ID, "2026-03-13T10:00:00.000Z");
    db.prepare(
      `INSERT INTO T_GAME_PARTICIPANT_GPA (GPA_GAME_ID, GPA_NAME, GPA_ORDER) VALUES (?, ?, ?)`
    ).run(GAME_ID, "Alice", 1);

    const res = await request(server)
      .get(`/api/v1/games/${GAME_ID}/results`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ranking).toHaveLength(1);
    expect(res.body.ranking[0].score).toBe(0);
    expect(res.body.questions).toHaveLength(0);
  });
});
