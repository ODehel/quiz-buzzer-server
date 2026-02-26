require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const config = require('./config');
const logger = require('./utils/logger');

logger.info('════════════════════════════════════════');
logger.info('   QuizBuzzer Server v1.0.0');
logger.info('════════════════════════════════════════');
logger.info(`Environment: ${config.server.env}`);
logger.info(`Port: ${config.server.port}`);

try {
  // ════��══════════════════════════════════
  // 1. EXPRESS
  // ═══════════════════════════════════════
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());

  // ═══════════════════════════════════════
  // 2. BASE DE DONNÉES (doit être initialisée AVANT tout le reste)
  // ═══════════════════════════════════════
  const databaseService = require('./services/database.service');
  databaseService.connect();
  logger.info('Database connected');

  // ═══════════════════════════════════════
  // 3. SERVICES (après la BDD)
  // ═══════════════════════════════════════
  const gameService = require('./services/game.service');

  // ═══════════════════════════════════════
  // 4. ROUTES (après les services)
  // ═══════════════════════════════════════
  const statusRoutes = require('./routes/status.routes');
  const authRoutes = require('./routes/auth.routes');
  const questionsRoutes = require('./routes/questions.routes');
  const gamesRoutes = require('./routes/games.routes');
  const jinglesRoutes = require('./routes/jingles.routes');

  app.use('/api/status', statusRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/questions', questionsRoutes);
  app.use('/api/games', gamesRoutes);
  app.use('/api/jingles', jinglesRoutes);

  // ═══════════════════════════════════════
  // 5. SERVEUR HTTP
  // ═══════════════════════════════════════
  const server = http.createServer(app);

  // ═══════════════════════════════════════
  // 6. WEBSOCKET (après le serveur HTTP)
  // ═══════════════════════════════════════
  const WebSocketServer = require('./websocket/server');
  const wss = new WebSocketServer(server);

  // 7. Injecter les dépendances dans le WebSocket
  const db = databaseService.getDb();
  wss.setDependencies(db, gameService);

  // ═══════════════════════════════════════
  // 8. DÉMARRER LE SERVEUR
  // ═══════════════════════════════════════
  server.listen(config.server.port, config.server.host, () => {
    logger.info('════════════════════════════════════════');
    logger.info(`HTTP Server listening on http://${config.server.host}:${config.server.port}`);
    logger.info(`WebSocket server ready on ws://${config.server.host}:${config.server.port}`);
    logger.info('════════════════════════════════════════');
    logger.info('Ready - 0 Angular, 0 Buzzers');
    logger.info('Press Ctrl+C to stop');
    logger.info('════════════════════════════════════════');
  });

  // ═══════════════════════════════════════
  // 9. ARRÊT PROPRE
  // ═══════════════════════════════════════
  process.on('SIGINT', () => {
    logger.info('');
    logger.info('Shutting down...');
    databaseService.close();
    server.close(() => {
      logger.info('Server stopped');
      process.exit(0);
    });
  });

  process.on('SIGTERM', () => {
    logger.info('SIGTERM received');
    databaseService.close();
    server.close(() => {
      process.exit(0);
    });
  });

} catch (error) {
  logger.error(`Failed to start server: ${error.message}`);
  console.error(error);
  process.exit(1);
}