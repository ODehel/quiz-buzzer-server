import { loadEnv } from "./config/env.js";
import { openDatabase } from "./database/database.js";
import { RateLimiter } from "./middlewares/rateLimiter.js";
import { createAuthenticateMiddleware } from "./middlewares/authenticate.js";
import { createAuthorizeMiddleware } from "./middlewares/authorize.js";
import { createTokenHandler } from "./routes/tokenRoute.js";
import {
  createThemesCollectionHandler,
  createThemeResourceHandler,
} from "./routes/themeRoute.js";
import {
  createQuestionsCollectionHandler,
  createQuestionResourceHandler,
  createQuestionsBulkHandler,
} from "./routes/questionRoute.js";
import { startServer } from "./server.js";
import { attachWebSocket } from "./websocket/wsServer.js";

const config = loadEnv();
const db = openDatabase();

// Middlewares réutilisables (DRY — CA-32, CA-33 / CA-80, CA-81)
const authenticate = createAuthenticateMiddleware(config.jwtSecret);
const authorize = createAuthorizeMiddleware("admin");

// Rate limiters
const tokenRateLimiter = new RateLimiter(5, 60_000);
const apiRateLimiter = new RateLimiter(100, 60_000); // CA-34 / CA-82 : 100 req/min

// Handlers
const tokenHandler = createTokenHandler(db, config, tokenRateLimiter);
const themesCollectionHandler = createThemesCollectionHandler(
  db, config, authenticate, authorize, apiRateLimiter
);
const themeResourceHandler = createThemeResourceHandler(
  db, config, authenticate, authorize, apiRateLimiter
);
const questionsCollectionHandler = createQuestionsCollectionHandler(
  db, config, authenticate, authorize, apiRateLimiter
);
const questionsBulkHandler = createQuestionsBulkHandler(
  db, config, authenticate, authorize, apiRateLimiter
);
const questionResourceHandler = createQuestionResourceHandler(
  db, config, authenticate, authorize, apiRateLimiter
);

/**
 * Routeur principal : dispatch les requêtes vers les handlers appropriés.
 */
function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/v1/token") {
    tokenHandler(req, res);
    return;
  }

  // Routes thèmes — collection
  if (url.pathname === "/api/v1/themes") {
    themesCollectionHandler(req, res, url);
    return;
  }

  // Routes thèmes — ressource individuelle (/api/v1/themes/:id)
  const themeMatch = url.pathname.match(/^\/api\/v1\/themes\/([^/]+)$/);
  if (themeMatch) {
    themeResourceHandler(req, res, url);
    return;
  }

  // Routes questions — collection
  if (url.pathname === "/api/v1/questions") {
    questionsCollectionHandler(req, res, url);
    return;
  }

  // Routes questions — insertion en lot (AVANT /:id pour éviter que "bulk" soit interprété comme un ID)
  if (url.pathname === "/api/v1/questions/bulk") {
    questionsBulkHandler(req, res);
    return;
  }

  // Routes questions — ressource individuelle (/api/v1/questions/:id)
  const questionMatch = url.pathname.match(/^\/api\/v1\/questions\/([^/]+)$/);
  if (questionMatch) {
    questionResourceHandler(req, res, url);
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

startServer({ port: config.port, requestHandler })
  .then((server) => attachWebSocket(server, db, config.jwtSecret));