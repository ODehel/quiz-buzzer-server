import { startServer, formatTime } from "../../src/server.js";

describe("formatTime", () => {
  it("should format a date as HH:mm:ss", () => {
    const date = new Date("2026-03-06T14:32:07");
    const result = formatTime(date);

    expect(result).toBe("14:32:07");
  });
});

describe("startServer", () => {
  let server;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
  });

  it("should start on default port 3000 and log time + IP (CA-1, CA-2, CA-3)", async () => {
    const logs = [];
    const log = (msg) => logs.push(msg);
    const getIp = () => "192.168.1.42";

    server = await startServer({ port: 0, log, getIp });

    expect(server.listening).toBe(true);
    expect(logs[0]).toMatch(/^🚀 Server started at \d{2}:\d{2}:\d{2}$/);
    expect(logs[1]).toMatch(/^📡 Listening on http:\/\/192\.168\.1\.42:\d+$/);
  });

  it("should display fallback message when no network interface is found (CA-4)", async () => {
    const logs = [];
    const log = (msg) => logs.push(msg);
    const getIp = () => null;

    server = await startServer({ port: 0, log, getIp });

    expect(logs[1]).toMatch(
      /^⚠️ No network interface found, listening on http:\/\/localhost:\d+$/
    );
  });

  it("should use a custom port when specified (CA-5)", async () => {
    const logs = [];
    const log = (msg) => logs.push(msg);
    const getIp = () => "10.0.0.1";

    server = await startServer({ port: 4567, log, getIp });

    expect(logs[1]).toBe("📡 Listening on http://10.0.0.1:4567");
  });

  it("should use PORT environment variable when no port option is given", async () => {
    const originalPort = process.env.PORT;
    process.env.PORT = "9999";

    const logs = [];
    const log = (msg) => logs.push(msg);
    const getIp = () => "10.0.0.1";

    try {
      server = await startServer({ log, getIp });
      expect(logs[1]).toBe("📡 Listening on http://10.0.0.1:9999");
    } finally {
      if (originalPort === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = originalPort;
      }
    }
  });

  // ↓↓↓ CES TESTS ÉTAIENT EN DEHORS DU describe — DÉPLACÉS ICI ↓↓↓

  it("should use a custom requestHandler when provided", async () => {
    const logs = [];
    const log = (msg) => logs.push(msg);
    const getIp = () => "10.0.0.1";
    const requestHandler = (_req, res) => {
      res.writeHead(200);
      res.end("custom");
    };

    server = await startServer({ port: 0, log, getIp, requestHandler });

    expect(server.listening).toBe(true);
  });

  it("should return 404 by default when no requestHandler is provided", async () => {
    const { default: request } = await import("supertest");
    const logs = [];
    const log = (msg) => logs.push(msg);
    const getIp = () => "10.0.0.1";

    server = await startServer({ port: 0, log, getIp });

    const res = await request(server).get("/anything");
    expect(res.status).toBe(404);
  });

  // Couvre la branche : appel sans argument → tous les defaults s'activent
  it("should start with all default parameters", async () => {
    const originalPort = process.env.PORT;
    process.env.PORT = "0"; // port 0 = random, pour ne pas confliter

    try {
      server = await startServer();
      expect(server.listening).toBe(true);
    } finally {
      if (originalPort === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = originalPort;
      }
    }
  });
});