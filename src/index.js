import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./config/env.js";
import { openDatabase } from "./database/database.js";
import { wrapDatabaseWithLogging } from "./database/sqlLogger.js";
import { withCorrelationId } from "./middlewares/correlationId.js";
import { withHttpLogger } from "./middlewares/httpLogger.js";
import { cleanOldLogs } from "./utils/logCleaner.js";
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
import { recoverInterruptedGame } from "./game/gameRecovery.js";
import { ensureUploadsDirectory } from "./middlewares/upload.js";
import {
  createQuizzesCollectionHandler,
  createQuizResourceHandler,
} from "./routes/quizRoute.js";
import {
  createGamesCollectionHandler,
  createGameResourceHandler,
  createGameStartHandler,
  createGameResultsHandler,
} from "./routes/gameRoute.js";
import {
  createSoundsCollectionHandler,
  createSoundResourceHandler,
} from "./routes/soundRoute.js";
import { createHealthHandler } from "./routes/health.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, "..", "uploads");

const config = loadEnv();
const db = wrapDatabaseWithLogging(openDatabase());

// Initialize uploads directory (CA-5)
await ensureUploadsDirectory(uploadsDir);

// Middlewares réutilisables (DRY — CA-32, CA-33 / CA-80, CA-81)
const authenticate = createAuthenticateMiddleware(config.jwtSecret);
const authorize = createAuthorizeMiddleware("admin");

// Rate limiters
const tokenRateLimiter = new RateLimiter(20, 60_000);
const apiRateLimiter = new RateLimiter(100, 60_000); // CA-34 / CA-82 : 100 req/min

// Handlers
const healthHandler = createHealthHandler();
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
const gameStartHandler = createGameStartHandler(
  db, config, authenticate, authorize, apiRateLimiter,
  {
    onGameStatusChange: (status) => gameStateNotifier.onGameStatusChange?.(status),
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
 * OCP: Registre de routes — ajouter une route = ajouter une entrée.
 *
 * Chaque route est définie par :
 * - path : chemin exact (string) ou pattern (RegExp)
 * - method : filtre optionnel sur la méthode HTTP
 * - handler : fonction (req, res, url) à appeler
 *
 * L'ordre est important : les routes plus spécifiques doivent précéder les plus génériques
 * (ex: /questions/bulk avant /questions/:id, /games/:id/results avant /games/:id).
 */
const routes = [
  // Public
  { path: "/api/v1/health", handler: healthHandler },
  { path: "/api/v1/token", handler: tokenHandler },

  // Themes
  { path: "/api/v1/themes", handler: themesCollectionHandler },
  { path: /^\/api\/v1\/themes\/[^/]+$/, handler: themeResourceHandler },

  // Questions — bulk avant /:id
  { path: "/api/v1/questions/bulk", handler: questionsBulkHandler },
  { path: /^\/api\/v1\/questions\/[^/]+\/media$/, method: "POST", handler: mediaUploadHandler },
  { path: /^\/api\/v1\/questions\/[^/]+\/media\/[^/]+$/, method: "DELETE", handler: mediaDeleteHandler },
  { path: "/api/v1/questions", handler: questionsCollectionHandler },
  { path: /^\/api\/v1\/questions\/[^/]+$/, handler: questionResourceHandler },

  // Quizzes
  { path: "/api/v1/quizzes", handler: quizzesCollectionHandler },
  { path: /^\/api\/v1\/quizzes\/[^/]+$/, handler: quizResourceHandler },

  // Games — start et results avant /:id
  { path: "/api/v1/games", handler: gamesCollectionHandler },
  { path: /^\/api\/v1\/games\/[^/]+\/start$/, method: "POST", handler: gameStartHandler },
  { path: /^\/api\/v1\/games\/[^/]+\/results$/, handler: gameResultsHandler },
  { path: /^\/api\/v1\/games\/[^/]+$/, handler: gameResourceHandler },

  // Sounds
  { path: "/api/v1/sounds", handler: soundsCollectionHandler },
  { path: /^\/api\/v1\/sounds\/[^/]+$/, handler: soundResourceHandler },
];

/**
 * Sert les fichiers son statiques (CA-29).
 */
function serveSoundFile(req, res, url) {
  const soundFileMatch = url.pathname.match(/^\/uploads\/sounds\/([^/]+)$/);
  if (!soundFileMatch || req.method !== "GET") return false;

  const filename = soundFileMatch[1];
  const filePath = path.join(uploadsDir, "sounds", filename);
  const mimeMap = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg" };
  const ext = path.extname(filename).toLowerCase();
  const mime = mimeMap[ext];

  if (!mime) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: 404, error: "NOT_FOUND", message: "The requested resource was not found." }));
    return true;
  }

  try {
    const stat = fs.statSync(filePath);
    res.writeHead(200, { "Content-Type": mime, "Content-Length": stat.size });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: 404, error: "NOT_FOUND", message: "The requested resource was not found." }));
  }
  return true;
}

/**
 * Routeur principal : dispatch les requêtes via le registre de routes.
 */
function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // Recherche dans le registre de routes
  for (const route of routes) {
    const pathMatch = typeof route.path === "string"
      ? url.pathname === route.path
      : route.path.test(url.pathname);

    if (pathMatch && (!route.method || route.method === req.method)) {
      route.handler(req, res, url);
      return;
    }
  }

  // Fichiers son statiques
  if (serveSoundFile(req, res, url)) return;

  // 404 pour toute autre route
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: 404,
    error: "NOT_FOUND",
    message: "The requested resource was not found.",
  }));
}

// US-019 CA-8: Reprise de partie interrompue AVANT l'ouverture des connexions
recoverInterruptedGame(db);

// US-022 CA-29: nettoyage des fichiers de log > 7 jours AVANT l'ouverture des connexions
// CA-15: pas de nettoyage en environnement test
if (process.env.NODE_ENV !== "test") {
  await cleanOldLogs();
}

// US-022: chaîne de middlewares — correlationId → httpLogger → requestHandler
const enhancedHandler = withHttpLogger(withCorrelationId(requestHandler));

startServer({ port: config.port, requestHandler: enhancedHandler })
  .then((server) => {
    const wss = attachWebSocket(server, db, config.jwtSecret, { serverBaseUrl: config.serverBaseUrl });
    // US-018 CA-7: wire game state changes to WebSocket notification
    gameStateNotifier.onGameStatusChange = (status) => wss._notifyGameStateChange?.(status);
    // Point de vigilance US-010: wire game deletion to orchestrator cleanup
    gameStateNotifier.onGameDeleted = (gameId) => wss._notifyGameDeleted?.(gameId);
  });