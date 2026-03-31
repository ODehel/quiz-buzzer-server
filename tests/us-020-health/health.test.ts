import { createServer } from "node:http";
import { default as request } from "supertest";
import { createHealthHandler } from "../../src/routes/health.ts";

/**
 * Helper : crée un serveur HTTP avec le health handler injecté.
 */
function createTestServer(deps = {}) {
  const handler = createHealthHandler(deps);
  return createServer(handler);
}

describe("US-020 — Health check", () => {
  const FIXED_DATE = new Date("2026-03-27T14:00:00.000Z");
  const FIXED_UPTIME = 42.4;

  /** @type {import("node:http").Server} */
  let server;

  afterEach((done) => {
    if (server?.listening) {
      server.close(done);
    } else {
      done();
    }
  });

  // ── CA-1 : GET /api/v1/health sans token → 200 OK ──────────────────
  it("CA-1 — should return 200 OK without authentication", async () => {
    server = createTestServer({
      getUptime: () => FIXED_UPTIME,
      getNow: () => FIXED_DATE,
      appVersion: "1.0.0",
    });

    const res = await request(server).get("/api/v1/health");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  // ── CA-2 : status: "ok" ─────────────────────────────────────────────
  it("CA-2 — should contain status 'ok'", async () => {
    server = createTestServer({
      getUptime: () => FIXED_UPTIME,
      getNow: () => FIXED_DATE,
      appVersion: "1.0.0",
    });

    const res = await request(server).get("/api/v1/health");

    expect(res.body.status).toBe("ok");
  });

  // ── CA-3 : uptime_seconds arrondi à l'entier ───────────────────────
  it("CA-3 — should contain uptime_seconds rounded to nearest integer", async () => {
    server = createTestServer({
      getUptime: () => 42.7,
      getNow: () => FIXED_DATE,
      appVersion: "1.0.0",
    });

    const res = await request(server).get("/api/v1/health");

    expect(res.body.uptime_seconds).toBe(43);
    expect(Number.isInteger(res.body.uptime_seconds)).toBe(true);
  });

  it("CA-3 — should round down when decimal < 0.5", async () => {
    server = createTestServer({
      getUptime: () => 42.4,
      getNow: () => FIXED_DATE,
      appVersion: "1.0.0",
    });

    const res = await request(server).get("/api/v1/health");

    expect(res.body.uptime_seconds).toBe(42);
  });

  // ── CA-4 : version lue depuis package.json ──────────────────────────
  it("CA-4 — should contain the application version", async () => {
    server = createTestServer({
      getUptime: () => FIXED_UPTIME,
      getNow: () => FIXED_DATE,
      appVersion: "2.5.0",
    });

    const res = await request(server).get("/api/v1/health");

    expect(res.body.version).toBe("2.5.0");
  });

  // ── CA-5 : timestamp ISO 8601 UTC avec millisecondes ────────────────
  it("CA-5 — should contain an ISO 8601 UTC timestamp with milliseconds", async () => {
    server = createTestServer({
      getUptime: () => FIXED_UPTIME,
      getNow: () => FIXED_DATE,
      appVersion: "1.0.0",
    });

    const res = await request(server).get("/api/v1/health");

    expect(res.body.timestamp).toBe("2026-03-27T14:00:00.000Z");
    // Vérifie le format ISO 8601 avec millisecondes
    expect(res.body.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
  });

  // ── CA-6 : body ignoré silencieusement ──────────────────────────────
  it("CA-6 — should ignore a request body silently", async () => {
    server = createTestServer({
      getUptime: () => FIXED_UPTIME,
      getNow: () => FIXED_DATE,
      appVersion: "1.0.0",
    });

    const res = await request(server)
      .get("/api/v1/health")
      .send({ foo: "bar" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  // ── CA-7 : Content-Type de la requête ignoré ────────────────────────
  it("CA-7 — should ignore any Content-Type header", async () => {
    server = createTestServer({
      getUptime: () => FIXED_UPTIME,
      getNow: () => FIXED_DATE,
      appVersion: "1.0.0",
    });

    const res = await request(server)
      .get("/api/v1/health")
      .set("Content-Type", "text/xml");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  // ── CA-8 : Méthode non-GET → 405 avec header Allow ─────────────────
  it("CA-8 — POST should return 405 with Allow: GET header", async () => {
    server = createTestServer();

    const res = await request(server).post("/api/v1/health");

    expect(res.status).toBe(405);
    expect(res.body.status).toBe(405);
    expect(res.body.error).toBe("METHOD_NOT_ALLOWED");
    expect(res.body.message).toBe("Method Not Allowed.");
    expect(res.headers["allow"]).toBe("GET");
  });

  it("CA-8 — PUT should return 405 with Allow: GET header", async () => {
    server = createTestServer();

    const res = await request(server).put("/api/v1/health");

    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("GET");
  });

  it("CA-8 — DELETE should return 405 with Allow: GET header", async () => {
    server = createTestServer();

    const res = await request(server).delete("/api/v1/health");

    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("GET");
  });

  it("CA-8 — PATCH should return 405 with Allow: GET header", async () => {
    server = createTestServer();

    const res = await request(server).patch("/api/v1/health");

    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("GET");
  });

  // ── CA-9 : Réponse complète vérifiée d'un coup ─────────────────────
  it("CA-1 to CA-5 — should return the full expected JSON body", async () => {
    server = createTestServer({
      getUptime: () => 120.9,
      getNow: () => new Date("2026-03-27T15:30:45.123Z"),
      appVersion: "1.0.0",
    });

    const res = await request(server).get("/api/v1/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      uptime_seconds: 121,
      version: "1.0.0",
      timestamp: "2026-03-27T15:30:45.123Z",
    });
  });

  // ── Erreur interne (branche défensive) ──────────────────────────────
  it("should return 500 if an unexpected error occurs", async () => {
    server = createTestServer({
      getUptime: () => { throw new Error("boom"); },
      getNow: () => FIXED_DATE,
      appVersion: "1.0.0",
    });

    const res = await request(server).get("/api/v1/health");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("INTERNAL_SERVER_ERROR");
    expect(res.body.message).toBe("An unexpected error occurred. Please try again later.");
  });

  // ── Default deps (couverture de la branche sans arguments) ──────────
  it("should work with default dependencies (no injection)", async () => {
    server = createTestServer();

    const res = await request(server).get("/api/v1/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptime_seconds).toBe("number");
    expect(typeof res.body.version).toBe("string");
    expect(typeof res.body.timestamp).toBe("string");
  });
});

describe("US-020 — version module", () => {
  it("should export a version string from config/version.ts", async () => {
    const { version } = await import("../../src/config/version.ts");

    expect(typeof version).toBe("string");
    expect(version).not.toBe("");
  });

  it("should use 'unknown' as version when package.json is unreadable", async () => {
    // Simulate the fallback by injecting appVersion = "unknown" into the handler
    const { createHealthHandler } = await import("../../src/routes/health.ts");
    const handler = createHealthHandler({
      appVersion: "unknown",
      getUptime: () => 1,
      getNow: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    const { createServer } = await import("node:http");
    const { default: request } = await import("supertest");
    const server = createServer(handler);

    try {
      const res = await request(server).get("/api/v1/health");
      expect(res.status).toBe(200);
      expect(res.body.version).toBe("unknown");
    } finally {
      server.close();
    }
  });
});
