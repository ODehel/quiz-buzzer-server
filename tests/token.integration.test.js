import { createServer } from "node:http";
import bcrypt from "bcrypt";
import Database from "better-sqlite3";
import request from "supertest";
import { createTokenHandler } from "../src/routes/tokenRoute.js";
import { RateLimiter } from "../src/middlewares/rateLimiter.js";

const TEST_CONFIG = {
  jwtSecret: "a-test-secret-that-is-at-least-32-characters-long!!",
  jwtExpiration: 3600,
};

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE T_USER_USR (
      USR_ID TEXT PRIMARY KEY,
      USR_USERNAME TEXT NOT NULL UNIQUE COLLATE NOCASE,
      USR_PASSWORD TEXT NOT NULL,
      USR_ROLE TEXT NOT NULL DEFAULT 'buzzer' CHECK (USR_ROLE IN ('admin','buzzer')),
      USR_CREATED_AT TEXT NOT NULL,
      USR_LAST_UPDATED_AT TEXT DEFAULT NULL
    );
  `);
  return db;
}

describe("POST /api/v1/token — integration", () => {
  let db;
  let rateLimiter;
  let server;

  beforeAll(async () => {
    db = createTestDb();
    const hash = await bcrypt.hash("ValidPassword1!", 10);
    db.prepare(
      "INSERT INTO T_USER_USR (USR_ID,USR_USERNAME,USR_PASSWORD,USR_ROLE,USR_CREATED_AT) VALUES (?,?,?,?,?)"
    ).run("018e4f5a-0000-7000-8000-000000000099", "admin", hash, "admin", new Date().toISOString());
  });

  beforeEach(() => {
    rateLimiter = new RateLimiter(5, 60_000);
    const handler = createTokenHandler(db, TEST_CONFIG, rateLimiter);
    server = createServer(handler);
  });

  afterAll(() => db.close());

  // CA-1
  it("should return 200 with JWT for valid credentials", async () => {
    const res = await request(server)
      .post("/api/v1/token")
      .send({ username: "admin", password: "ValidPassword1!" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("token");
    expect(res.body.expires_in).toBe(3600);
    expect(res.body.token_type).toBe("Bearer");
  });

  // CA-7
  it("should return 415 for non-JSON Content-Type", async () => {
    const res = await request(server)
      .post("/api/v1/token")
      .set("Content-Type", "text/plain")
      .send("not json");

    expect(res.status).toBe(415);
    expect(res.body.error).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  // CA-8
  it("should return 401 for wrong password", async () => {
    const res = await request(server)
      .post("/api/v1/token")
      .send({ username: "admin", password: "WrongPassword!!" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("INVALID_CREDENTIALS");
    expect(res.body.message).toBe("Invalid credentials.");
  });

  // CA-9 : username manquant (undefined)
  it("should return 400 VALIDATION_ERROR when username is missing", async () => {
    const res = await request(server)
      .post("/api/v1/token")
      .send({ password: "ValidPassword1!" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  // CA-9 : username vide (empty string) — couvre la branche line 117
  it("should return 400 VALIDATION_ERROR when username is empty string", async () => {
    const res = await request(server)
      .post("/api/v1/token")
      .send({ username: "", password: "ValidPassword1!" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  // CA-9 : username null — couvre l'autre sous-branche line 117
  it("should return 400 VALIDATION_ERROR when username is null", async () => {
    const res = await request(server)
      .post("/api/v1/token")
      .send({ username: null, password: "ValidPassword1!" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  // CA-10 : password manquant
  it("should return 400 VALIDATION_ERROR when password is missing", async () => {
    const res = await request(server)
      .post("/api/v1/token")
      .send({ username: "admin" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  // CA-10 : password vide
  it("should return 400 VALIDATION_ERROR when password is empty string", async () => {
    const res = await request(server)
      .post("/api/v1/token")
      .send({ username: "admin", password: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
  });

  // INVALID_BODY : body JSON valide mais pas un objet
  it("should return 400 INVALID_BODY when body is a JSON array", async () => {
    const res = await request(server)
      .post("/api/v1/token")
      .set("Content-Type", "application/json")
      .send(JSON.stringify([1, 2, 3]));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_BODY");
    expect(res.body.message).toBe("Request body must be a JSON object.");
  });

  // CA-11
  it("should return 400 INVALID_JSON for malformed body", async () => {
    const res = await request(server)
      .post("/api/v1/token")
      .set("Content-Type", "application/json")
      .send("{not valid json}");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_JSON");
  });

  // CA-12
  it("should return 400 UNKNOWN_FIELDS for extra fields", async () => {
    const res = await request(server)
      .post("/api/v1/token")
      .send({ username: "admin", password: "ValidPassword1!", extra: "field" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("UNKNOWN_FIELDS");
    expect(res.body.message).toContain("extra");
  });

  // CA-13
  it("should return 429 after 5 requests from same IP", async () => {
    for (let i = 0; i < 5; i++) {
      await request(server)
        .post("/api/v1/token")
        .send({ username: "admin", password: "ValidPassword1!" });
    }

    const res = await request(server)
      .post("/api/v1/token")
      .send({ username: "admin", password: "ValidPassword1!" });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("RATE_LIMIT_EXCEEDED");
    expect(res.headers["retry-after"]).toBe("60");
  });

  // CA-16
  it("should return 405 for GET method with Allow header", async () => {
    const res = await request(server).get("/api/v1/token");

    expect(res.status).toBe(405);
    expect(res.body.error).toBe("METHOD_NOT_ALLOWED");
    expect(res.headers["allow"]).toBe("POST");
  });

  // ↓↓↓ CE TEST ÉTAIT EN DEHORS DU describe — DÉPLACÉ ICI ↓↓↓

  // CA-21 : Erreur serveur inattendue → 500
  it("should return 500 INTERNAL_SERVER_ERROR on unexpected failure", async () => {
    const brokenDb = new Database(":memory:");
    brokenDb.exec(`
      CREATE TABLE T_USER_USR (
        USR_ID TEXT PRIMARY KEY,
        USR_USERNAME TEXT NOT NULL UNIQUE COLLATE NOCASE,
        USR_PASSWORD TEXT NOT NULL,
        USR_ROLE TEXT NOT NULL DEFAULT 'buzzer' CHECK (USR_ROLE IN ('admin','buzzer')),
        USR_CREATED_AT TEXT NOT NULL,
        USR_LAST_UPDATED_AT TEXT DEFAULT NULL
      );
    `);
    brokenDb.close(); // DB fermée volontairement

    const brokenRateLimiter = new RateLimiter(5, 60_000);
    const brokenHandler = createTokenHandler(brokenDb, TEST_CONFIG, brokenRateLimiter);
    const brokenServer = createServer(brokenHandler);

    const res = await request(brokenServer)
      .post("/api/v1/token")
      .send({ username: "admin", password: "ValidPassword1!" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("INTERNAL_SERVER_ERROR");
    expect(res.body.message).toBe("An unexpected error occurred. Please try again later.");
  });
});