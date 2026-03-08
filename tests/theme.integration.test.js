import { createServer } from "node:http";
import { openDatabase } from "../src/database/database.js";
import { createAuthenticateMiddleware } from "../src/middlewares/authenticate.js";
import { createAuthorizeMiddleware } from "../src/middlewares/authorize.js";
import { RateLimiter } from "../src/middlewares/rateLimiter.js";
import {
  createThemesCollectionHandler,
  createThemeResourceHandler,
} from "../src/routes/themeRoute.js";
import jwt from "jsonwebtoken";
import request from "supertest";

const JWT_SECRET = "a".repeat(32);
const config = { jwtSecret: JWT_SECRET, jwtExpiration: 3600 };

let db, server, adminToken;

function makeToken(role = "admin") {
  return jwt.sign(
    { sub: "018e4f5a-8c3b-7d2e-9f1a-000000000001", role },
    JWT_SECRET,
    { algorithm: "HS256", expiresIn: 3600 }
  );
}

beforeEach((done) => {
  db = openDatabase(":memory:");
  const authenticate = createAuthenticateMiddleware(JWT_SECRET);
  const authorize = createAuthorizeMiddleware("admin");
  const rateLimiter = new RateLimiter(100, 60_000);
  const collectionHandler = createThemesCollectionHandler(db, config, authenticate, authorize, rateLimiter);
  const resourceHandler = createThemeResourceHandler(db, config, authenticate, authorize, rateLimiter);
  adminToken = makeToken("admin");

  server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/v1/themes") {
      collectionHandler(req, res, url);
    } else if (url.pathname.match(/^\/api\/v1\/themes\/[^/]+$/)) {
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

describe("POST /api/v1/themes", () => {
  test("201 - creates a theme", async () => {
    const res = await request(server)
      .post("/api/v1/themes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Musique" });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Musique");
    expect(res.body.last_updated_at).toBeNull();
  });

  test("401 - missing token", async () => {
    const res = await request(server)
      .post("/api/v1/themes")
      .send({ name: "Musique" });
    expect(res.status).toBe(401);
  });

  test("403 - non-admin token", async () => {
    const buzzerToken = makeToken("buzzer");
    const res = await request(server)
      .post("/api/v1/themes")
      .set("Authorization", `Bearer ${buzzerToken}`)
      .send({ name: "Musique" });
    expect(res.status).toBe(403);
  });

  test("409 - duplicate name", async () => {
    await request(server)
      .post("/api/v1/themes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Musique" });
    const res = await request(server)
      .post("/api/v1/themes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "MUSIQUE" });
    expect(res.status).toBe(409);
  });

  test("400 - unknown fields", async () => {
    const res = await request(server)
      .post("/api/v1/themes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Musique", foo: "bar" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("UNKNOWN_FIELDS");
  });

  test("415 - wrong content type", async () => {
    const res = await request(server)
      .post("/api/v1/themes")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Content-Type", "text/plain")
      .send("not json");
    expect(res.status).toBe(415);
  });

  test("405 - PATCH not allowed", async () => {
    const res = await request(server)
      .patch("/api/v1/themes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("GET, POST");
  });
});

describe("GET /api/v1/themes", () => {
  test("200 - empty list", async () => {
    const res = await request(server)
      .get("/api/v1/themes")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      data: [], page: 1, limit: 20, total: 0, total_pages: 0,
    });
  });

  test("400 - invalid pagination", async () => {
    const res = await request(server)
      .get("/api/v1/themes?page=-1")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_PAGINATION");
  });

  test("400 - limit > 100", async () => {
    const res = await request(server)
      .get("/api/v1/themes?limit=200")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/themes/:id", () => {
  test("200 - get by ID", async () => {
    const created = await request(server)
      .post("/api/v1/themes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Musique" });
    const res = await request(server)
      .get(`/api/v1/themes/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Musique");
  });

  test("400 - invalid UUID", async () => {
    const res = await request(server)
      .get("/api/v1/themes/not-a-uuid")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_UUID");
  });

  test("404 - not found", async () => {
    const res = await request(server)
      .get("/api/v1/themes/018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/v1/themes/:id", () => {
  test("200 - update name", async () => {
    const created = await request(server)
      .post("/api/v1/themes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Musique" });
    const res = await request(server)
      .put(`/api/v1/themes/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Histoire" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Histoire");
    expect(res.body.last_updated_at).not.toBeNull();
  });

  test("CA-22 - same name no timestamp update", async () => {
    const created = await request(server)
      .post("/api/v1/themes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Musique" });
    const res = await request(server)
      .put(`/api/v1/themes/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "musique" });
    expect(res.status).toBe(200);
    expect(res.body.last_updated_at).toBeNull();
  });

  test("CA-23 - ID mismatch", async () => {
    const created = await request(server)
      .post("/api/v1/themes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Musique" });
    const res = await request(server)
      .put(`/api/v1/themes/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ id: "018e4f5a-8c3b-7d2e-9f1a-000000000000", name: "Sport" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ID_MISMATCH");
  });
});

describe("DELETE /api/v1/themes/:id", () => {
  test("204 - delete existing theme", async () => {
    const created = await request(server)
      .post("/api/v1/themes")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Musique" });
    const res = await request(server)
      .delete(`/api/v1/themes/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(204);
  });

  test("404 - delete non-existent", async () => {
    const res = await request(server)
      .delete("/api/v1/themes/018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});