import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./config/env.ts";
import { openDatabase } from "./database/database.ts";
import { wrapDatabaseWithLogging } from "./database/sqlLogger.ts";
import { withCorrelationId } from "./middlewares/correlationId.ts";
import { withHttpLogger } from "./middlewares/httpLogger.ts";
import { cleanOldLogs } from "./utils/logCleaner.ts";
import { RateLimiter } from "./middlewares/rateLimiter.ts";
import { createAuthenticateMiddleware } from "./middlewares/authenticate.ts";
import { createAuthorizeMiddleware } from "./middlewares/authorize.ts";
import { createTokenHandler } from "./routes/tokenRoute.ts";
import {
  createThemesCollectionHandler,
  createThemeResourceHandler,
} from "./routes/themeRoute.ts";
import {
  createQuestionsCollectionHandler,
  createQuestionResourceHandler,
  createQuestionsBulkHandler,
  createMediaUploadHandler,
  createMediaDeleteHandler,
} from "./routes/questionRoute.ts";
import { startServer } from "./server.ts";
import { attachWebSocket } from "./websocket/wsServer.ts";
import { recoverInterruptedGame } from "./game/gameRecovery.ts";
import { ensureUploadsDirectory } from "./middlewares/upload.ts";
import {
  createQuizzesCollectionHandler,
  createQuizResourceHandler,
} from "./routes/quizRoute.ts";
import {
  createGamesCollectionHandler,
  createGameResourceHandler,
  createGameStartHandler,
  createGameResultsHandler,
} from "./routes/gameRoute.ts";
import {
  createSoundsCollectionHandler,
  createSoundResourceHandler,
} from "./routes/soundRoute.ts";
import { createHealthHandler } from "./routes/health.ts";
import { IncomingMessage, ServerResponse } from "node:http";
import { AppRequest, RouteEntry, GameStatus } from "./types/index.ts";
import { sendJson } from "./utils/sendJson.ts";

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
const gameStateNotifier: {
  onGameStatusChange: ((status: GameStatus) => void) | null;
  onGameDeleted: ((gameId: string) => void) | null;
} = { onGameStatusChange: null, onGameDeleted: null };

const gamesCollectionHandler = createGamesCollectionHandler(
  db, config, authenticate, authorize, apiRateLimiter
);
const gameResourceHandler = createGameResourceHandler(
  db, config, authenticate, authorize, apiRateLimiter,
  {
    onGameStatusChange: (status: string) => gameStateNotifier.onGameStatusChange?.(status as GameStatus),
    onGameDeleted: (gameId: string) => gameStateNotifier.onGameDeleted?.(gameId),
  }
);
const gameStartHandler = createGameStartHandler(
  db, config, authenticate, authorize, apiRateLimiter,
  {
    onGameStatusChange: (status: string) => gameStateNotifier.onGameStatusChange?.(status as GameStatus),
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
 */
const routes: RouteEntry[] = [
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
function serveSoundFile(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const soundFileMatch = url.pathname.match(/^\/uploads\/sounds\/([^/]+)$/);
  if (!soundFileMatch || req.method !== "GET") return false;

  const filename = soundFileMatch[1];
  const filePath = path.join(uploadsDir, "sounds", filename);
  const mimeMap: Record<string, string> = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg" };
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
function requestHandler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url!, `http://${req.headers.host || "localhost"}`);

  // Recherche dans le registre de routes
  for (const route of routes) {
    const pathMatch = typeof route.path === "string"
      ? url.pathname === route.path
      : route.path.test(url.pathname);

    if (pathMatch && (!route.method || route.method === req.method)) {
      route.handler(req as AppRequest, res, url);
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
    gameStateNotifier.onGameStatusChange = (status: GameStatus) => (wss as any)._notifyGameStateChange?.(status);
    // Point de vigilance US-010: wire game deletion to orchestrator cleanup
    gameStateNotifier.onGameDeleted = (gameId: string) => (wss as any)._notifyGameDeleted?.(gameId);
  });
