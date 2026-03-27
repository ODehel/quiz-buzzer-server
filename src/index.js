import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
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
  createMediaUploadHandler,
  createMediaDeleteHandler,
} from "./routes/questionRoute.js";
import { startServer } from "./server.js";
import { attachWebSocket } from "./websocket/wsServer.js";
import { ensureUploadsDirectory } from "./middlewares/upload.js";
import {
  createQuizzesCollectionHandler,
  createQuizResourceHandler,
} from "./routes/quizRoute.js";
import {
  createGamesCollectionHandler,
  createGameResourceHandler,
  createGameResultsHandler,
} from "./routes/gameRoute.js";
import {
  createSoundsCollectionHandler,
  createSoundResourceHandler,
} from "./routes/soundRoute.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, "..", "uploads");

const config = loadEnv();
const db = openDatabase();

// Initialize uploads directory (CA-5)
await ensureUploadsDirectory(uploadsDir);

// Middlewares réutilisables (DRY — CA-32, CA-33 / CA-80, CA-81)
const authenticate = createAuthenticateMiddleware(config.jwtSecret);
const authorize = createAuthorizeMiddleware("admin");

// Rate limiters
const tokenRateLimiter = new RateLimiter(20, 60_000);
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
  db, config, authenticate, authorize, apiRateLimiter, uploadsDir
);
const mediaUploadHandler = createMediaUploadHandler(
  db, config, authenticate, authorize, apiRateLimiter, uploadsDir
);
const mediaDeleteHandler = createMediaDeleteHandler(
  db, config, authenticate, authorize, apiRateLimiter, uploadsDir
);
const quizzesCollectionHandler = createQuizzesCollectionHandler(
  db, config, authenticate, authorize, apiRateLimiter
);
const quizResourceHandler = createQuizResourceHandler(
  db, config, authenticate, authorize, apiRateLimiter
);
// US-018: shared callback for game state changes (set by WebSocket server)
// Point de vigilance US-010: add onGameDeleted callback for cleaning up orchestrator state before SQL deletion
const gameStateNotifier = { onGameStatusChange: null, onGameDeleted: null };

const gamesCollectionHandler = createGamesCollectionHandler(
  db, config, authenticate, authorize, apiRateLimiter
);
const gameResourceHandler = createGameResourceHandler(
  db, config, authenticate, authorize, apiRateLimiter,
  {
    onGameStatusChange: (status) => gameStateNotifier.onGameStatusChange?.(status),
    onGameDeleted: (gameId) => gameStateNotifier.onGameDeleted?.(gameId),
  }
);
const gameResultsHandler = createGameResultsHandler(
  db, config, authenticate, authorize, apiRateLimiter
);
const soundsCollectionHandler = createSoundsCollectionHandler(
  db, config, authenticate, authorize, apiRateLimiter, uploadsDir
);
const soundResourceHandler = createSoundResourceHandler(
  db, config, authenticate, authorize, apiRateLimiter, uploadsDir
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

  // Routes médias — upload (/api/v1/questions/:id/media) — POST
  const mediaUploadMatch = url.pathname.match(/^\/api\/v1\/questions\/([^/]+)\/media$/);
  if (mediaUploadMatch && req.method === "POST") {
    mediaUploadHandler(req, res, url);
    return;
  }

  // Routes médias — suppression (/api/v1/questions/:id/media/:type) — DELETE
  const mediaDeleteMatch = url.pathname.match(/^\/api\/v1\/questions\/([^/]+)\/media\/([^/]+)$/);
  if (mediaDeleteMatch && req.method === "DELETE") {
    mediaDeleteHandler(req, res, url);
    return;
  }

  // Routes questions — ressource individuelle (/api/v1/questions/:id)
  const questionMatch = url.pathname.match(/^\/api\/v1\/questions\/([^/]+)$/);
  if (questionMatch) {
    questionResourceHandler(req, res, url);
    return;
  }

  // Routes quiz — collection
  if (url.pathname === "/api/v1/quizzes") {
    quizzesCollectionHandler(req, res, url);
    return;
  }

  // Routes quiz — ressource individuelle (/api/v1/quizzes/:id)
  const quizMatch = url.pathname.match(/^\/api\/v1\/quizzes\/([^/]+)$/);
  if (quizMatch) {
    quizResourceHandler(req, res, url);
    return;
  }

  // Routes parties — collection
  if (url.pathname === "/api/v1/games") {
    gamesCollectionHandler(req, res, url);
    return;
  }

  // Routes parties — résultats (/api/v1/games/:id/results)
  const gameResultsMatch = url.pathname.match(/^\/api\/v1\/games\/[^/]+\/results$/);
  if (gameResultsMatch) {
    gameResultsHandler(req, res, url);
    return;
  }

  // Routes parties — ressource individuelle (/api/v1/games/:id)
  const gameMatch = url.pathname.match(/^\/api\/v1\/games\/([^/]+)$/);
  if (gameMatch) {
    gameResourceHandler(req, res, url);
    return;
  }

  // Serve static sound files (CA-29)
  const soundFileMatch = url.pathname.match(/^\/uploads\/sounds\/([^/]+)$/);
  if (soundFileMatch && req.method === "GET") {
    const filename = soundFileMatch[1];
    const filePath = path.join(uploadsDir, "sounds", filename);
    const mimeMap = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg" };
    const ext = path.extname(filename).toLowerCase();
    const mime = mimeMap[ext];
    if (!mime) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: 404, error: "NOT_FOUND", message: "The requested resource was not found." }));
      return;
    }
    try {
      const stat = fs.statSync(filePath);
      res.writeHead(200, { "Content-Type": mime, "Content-Length": stat.size });
      fs.createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: 404, error: "NOT_FOUND", message: "The requested resource was not found." }));
    }
    return;
  }

  // Routes sons — collection
  if (url.pathname === "/api/v1/sounds") {
    soundsCollectionHandler(req, res, url);
    return;
  }

  // Routes sons — ressource individuelle (/api/v1/sounds/:id)
  const soundMatch = url.pathname.match(/^\/api\/v1\/sounds\/([^/]+)$/);
  if (soundMatch) {
    soundResourceHandler(req, res, url);
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
  .then((server) => {
    const wss = attachWebSocket(server, db, config.jwtSecret, { serverBaseUrl: config.serverBaseUrl });
    // US-018 CA-7: wire game state changes to WebSocket notification
    gameStateNotifier.onGameStatusChange = (status) => wss._notifyGameStateChange?.(status);
    // Point de vigilance US-010: wire game deletion to orchestrator cleanup
    gameStateNotifier.onGameDeleted = (gameId) => wss._notifyGameDeleted?.(gameId);
  });