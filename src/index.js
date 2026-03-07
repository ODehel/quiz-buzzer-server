import { loadEnv } from "./config/env.js";
import { openDatabase } from "./database/database.js";
import { RateLimiter } from "./middlewares/rateLimiter.js";
import { createTokenHandler } from "./routes/tokenRoute.js";
import { startServer } from "./server.js";

const config = loadEnv();
const db = openDatabase();
const tokenRateLimiter = new RateLimiter(5, 60_000);
const tokenHandler = createTokenHandler(db, config, tokenRateLimiter);

/**
 * Routeur principal : dispatch les requêtes vers les handlers appropriés.
 */
function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/v1/token") {
    tokenHandler(req, res);
    return;
  }

  // 404 pour toute autre route
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: 404,
    error: "NOT_FOUND",
    message: "The requested resource was not found.",
  }));
}

startServer({ port: config.port, requestHandler });