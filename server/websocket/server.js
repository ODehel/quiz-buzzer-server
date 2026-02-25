const WebSocket = require('ws');
const logger = require('../utils/logger');

class WebSocketServer {
  constructor(httpServer) {
    this.wss = new WebSocket.Server({ server: httpServer });
    this.angularClient = null;
    this.buzzerClients = new Map(); // buzzerID → { ws, info }
    this.db = null;
    this.gameService = null;

    this.setupServer();
    logger.info('WebSocket server ready');
  }

  /**
   * Injecter les dépendances (appelé depuis index.js)
   */
  setDependencies(db, gameService) {
    this.db = db;
    this.gameService = gameService;

    // Callback quand un gagnant de buzz est déterminé
    if (this.gameService) {
      this.gameService.onBuzzWinner = (gameId, questionId, winner) => {
        logger.info(`[Buzz] Winner callback: ${winner.buzzerID} (${winner.responseTime}ms)`);

        // Bloquer tous les buzzers
        this.broadcastToBuzzers('BUZZER_LOCKED', {
          gameId,
          questionId,
          winnerID: winner.buzzerID,
        });

        // Notifier Angular
        const buzzerData = this.buzzerClients.get(winner.buzzerID);
        const playerName = buzzerData ? buzzerData.info.name : winner.buzzerID;

        this.sendToAngular('BUZZ_WINNER', {
          buzzerID: winner.buzzerID,
          playerName,
          questionId,
          gameId,
          responseTime: winner.responseTime,
        });
      };
    }

    logger.info('[WebSocket] Dependencies injected (db, gameService)');
  }

  /**
   * Configurer le serveur WebSocket
   */
  setupServer() {
    this.wss.on('connection', (ws, req) => {
      const ip = req.socket.remoteAddress;
      logger.info(`[WebSocket] New connection from ${ip}`);

      // Timeout identification : 30 secondes
      const identificationTimeout = setTimeout(() => {
        if (!ws._identified) {
          logger.warn(`[WebSocket] Connection from ${ip} timed out`);
          ws.close(4001, 'Identification timeout');
        }
      }, 30000);

      ws._identified = false;
      ws._ip = ip;

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.routeMessage(ws, message, identificationTimeout);
        } catch (error) {
          logger.error(`[WebSocket] Parse error: ${error.message}`);
        }
      });

      ws.on('close', (code, reason) => {
        clearTimeout(identificationTimeout);
        this.handleDisconnection(ws, code, reason);
      });

      ws.on('error', (error) => {
        logger.error(`[WebSocket] Error: ${error.message}`);
      });

      // Heartbeat
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
    });

    // Vérifier les connexions mortes toutes les 30 secondes
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
          logger.warn('[WebSocket] Terminating dead connection');
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);
  }

  /**
   * Router les messages selon l'état du client
   */
  routeMessage(ws, message, identificationTimeout) {
    if (!ws._identified) {
      switch (message.type) {
        case 'ANGULAR_CONNECT':
          ws._identified = true;
          ws._clientType = 'angular';
          clearTimeout(identificationTimeout);
          this.handleAngularConnection(ws, message);
          break;

        case 'BUZZER_REGISTER':
          ws._identified = true;
          ws._clientType = 'buzzer';
          ws._buzzerID = message.payload.buzzerID;
          clearTimeout(identificationTimeout);
          this.handleBuzzerRegistration(ws, message);
          break;

        default:
          this.handlePreIdentificationMessage(ws, message);
          break;
      }
    } else {
      if (ws._clientType === 'angular') {
        this.handleAngularMessage(ws, message);
      } else if (ws._clientType === 'buzzer') {
        this.handleBuzzerMessage(ws._buzzerID, ws, message);
      }
    }
  }

  /**
   * Messages avant identification
   */
  handlePreIdentificationMessage(ws, message) {
    switch (message.type) {
      case 'TIME_SYNC_REQ':
        this.sendToClient(ws, 'TIME_SYNC_RES', {
          T1: message.payload.T1,
          T2: Date.now(),
          T3: Date.now(),
        });
        break;

      case 'PING':
        this.sendToClient(ws, 'PONG', {
          T_send: message.payload.T_send,
          T_receive: Date.now(),
        });
        break;

      default:
        logger.debug(`[WebSocket] Ignoring pre-id message: ${message.type}`);
        break;
    }
  }

  // ═══════════════════════════════════════════════════
  // CONNEXION / DÉCONNEXION
  // ═══════════════════════════════════════════════════

  /**
   * Connexion Angular
   */
  handleAngularConnection(ws, message) {
    this.angularClient = ws;
    logger.info('[WebSocket] Angular connected');

    this.sendToClient(ws, 'CONNECTED', {
      sessionID: 'session_' + Date.now().toString(36),
      serverTime: Date.now(),
      config: { maxBuzzers: 10, version: '1.0.0' },
    });

    // ⭐ Envoyer immédiatement la liste des buzzers déjà connectés
    this.sendBuzzerListToAngular();

    this.logConnectionStatus();
  }

  /**
   * Enregistrement d'un buzzer
   */
  handleBuzzerRegistration(ws, message) {
    const { buzzerID, macAddress } = message.payload;

    // Vérifier doublon
    if (this.buzzerClients.has(buzzerID)) {
      logger.warn(`[WebSocket] Duplicate buzzer: ${buzzerID}`);
      this.sendToClient(ws, 'CONNECTION_REJECTED', {
        reason: 'Buzzer ID already connected',
      });
      ws.close(4002, 'Duplicate buzzer ID');
      return;
    }

    const playerNumber = this.buzzerClients.size + 1;
    const buzzerInfo = {
      name: 'En attente de nom',
      macAddress: macAddress || 'unknown',
      connectedAt: Date.now(),
      playerNumber,
      ip: ws._ip,
      battery: null,
      wifiRSSI: null,
      latency: null,
    };

    this.buzzerClients.set(buzzerID, { ws, info: buzzerInfo });
    logger.info(`[WebSocket] Buzzer registered: ${buzzerID} (#${playerNumber})`);

    // Répondre au buzzer
    this.sendToClient(ws, 'CONNECTION_ACK', {
      buzzerID,
      name: buzzerInfo.name,
      serverTime: Date.now(),
      playerNumber,
    });

    // Notifier Angular
    this.sendToAngular('BUZZER_CONNECTED', {
      buzzer: {
        id: buzzerID,
        name: buzzerInfo.name,
        connectedAt: buzzerInfo.connectedAt,
      },
      totalBuzzers: this.buzzerClients.size,
    });

    this.logConnectionStatus();
  }

  /**
   * Déconnexion d'un client
   */
  handleDisconnection(ws, code, reason) {
    if (ws._clientType === 'angular') {
      logger.info('[WebSocket] Angular disconnected');
      this.angularClient = null;
    } else if (ws._clientType === 'buzzer' && ws._buzzerID) {
      logger.info(`[WebSocket] Buzzer ${ws._buzzerID} disconnected (code: ${code})`);
      this.buzzerClients.delete(ws._buzzerID);

      this.sendToAngular('BUZZER_DISCONNECTED', {
        buzzerID: ws._buzzerID,
        totalBuzzers: this.buzzerClients.size,
      });
    }

    this.logConnectionStatus();
  }

  // ═══════════════════════════════════════════════════
  // MESSAGES ANGULAR → SERVEUR
  // ═══════════════════════════════════════════════════

  handleAngularMessage(ws, message) {
    logger.info(`[Angular] → ${message.type}`);

    switch (message.type) {
      case 'REQUEST_BUZZER_LIST':
        this.sendBuzzerListToAngular();
        break;

      case 'PLAYER_RENAME':
        this.handlePlayerRename(message);
        break;

      case 'QUESTION_SEND':
        this.handleQuestionSend(message);
        break;

      case 'GAME_START':
        this.handleGameStart(message);
        break;

      case 'BUZZER_DISCONNECT':
        this.handleBuzzerForceDisconnect(message);
        break;

      case 'BUZZ_CORRECT':
        this.handleBuzzCorrect(message);
        break;

      case 'BUZZ_REOPEN':
        this.handleBuzzReopen(message);
        break;

      default:
        logger.debug(`[Angular] Unhandled: ${message.type}`);
    }
  }

  /**
   * ⭐ Envoyer la liste complète des buzzers connectés à Angular
   */
  sendBuzzerListToAngular() {
    if (this.buzzerClients.size === 0) {
      this.sendToAngular('BUZZER_LIST_UPDATE', {
        buzzers: [],
        total: 0,
      });
      return;
    }

    const buzzersList = Array.from(this.buzzerClients.entries()).map(([id, data]) => ({
      id,
      name: data.info.name,
      connectedAt: data.info.connectedAt,
      battery: data.info.battery,
      wifiRSSI: data.info.wifiRSSI,
      latency: data.info.latency,
      connected: true,
    }));

    this.sendToAngular('BUZZER_LIST_UPDATE', {
      buzzers: buzzersList,
      total: buzzersList.length,
    });

    logger.info(`[WebSocket] Sent buzzer list to Angular: ${buzzersList.length} buzzers`);
  }

  /**
   * Renommer un joueur
   */
  handlePlayerRename(message) {
    const { buzzerID, newName } = message.payload;
    const buzzerData = this.buzzerClients.get(buzzerID);

    if (buzzerData) {
      buzzerData.info.name = newName;
      this.sendToBuzzer(buzzerID, 'PLAYER_NAME_UPDATE', { name: newName });
      logger.info(`[Player] ${buzzerID} renamed to "${newName}"`);
    }
  }

  /**
   * Envoyer une question à tous les buzzers
   */
  handleQuestionSend(message) {
    const { gameId, questionId } = message.payload;

    logger.info(`[Game] Sending question ${questionId} to ${this.buzzerClients.size} buzzers`);

    // Récupérer la question depuis la BDD
    let question = null;

    if (this.db) {
      try {
        question = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId);
      } catch (err) {
        logger.error(`[Game] Error fetching question: ${err.message}`);
      }
    }

    if (!question && this.gameService) {
      try {
        question = this.gameService.getCurrentQuestion(gameId);
      } catch (err) {
        logger.error(`[Game] Error from gameService: ${err.message}`);
      }
    }

    if (!question) {
      logger.error(`[Game] Question ${questionId} not found!`);
      this.sendToAngular('ERROR', {
        message: `Question ${questionId} introuvable`,
      });
      return;
    }

    // Préparer les données de la question pour les buzzers
    const questionPayload = {
      gameId,
      id: question.id,
      text: question.text,
      type: question.type,
      category: question.category || '',
      points: question.points || 10,
      startTime: Date.now(),
    };

    // Ajouter les réponses pour les QCM
    if (question.type === 'MCQ') {
      let answers = question.answers;
      if (typeof answers === 'string') {
        try {
          answers = JSON.parse(answers);
        } catch (e) {
          answers = [answers];
        }
      }
      questionPayload.answers = answers;
      questionPayload.correct_answer = question.correct_answer;
    }

    // Envoyer à TOUS les buzzers connectés
    let sentCount = 0;
    this.buzzerClients.forEach((data, buzzerID) => {
      this.sendToBuzzer(buzzerID, 'QUESTION_START', questionPayload);
      sentCount++;
    });

    logger.info(`[Game] Question sent to ${sentCount} buzzers`);

    // Confirmer à Angular
    this.sendToAngular('QUESTION_SENT', {
      questionId: question.id,
      sentTo: sentCount,
      timestamp: Date.now(),
    });
  }

  /**
   * Démarrer une partie
   */
  handleGameStart(message) {
    logger.info(`[Game] Starting game: ${message.payload.gameId}`);

    this.broadcastToBuzzers('GAME_STARTED', {
      gameId: message.payload.gameId,
      name: message.payload.name,
      totalQuestions: message.payload.totalQuestions,
    });
  }

  /**
   * Forcer la déconnexion d'un buzzer
   */
  handleBuzzerForceDisconnect(message) {
    const { buzzerID } = message.payload;
    const buzzerData = this.buzzerClients.get(buzzerID);

    if (buzzerData) {
      logger.info(`[WebSocket] Force disconnecting ${buzzerID}`);
      buzzerData.ws.close(4003, 'Disconnected by admin');
    }
  }

  /**
   * Angular confirme que le buzz est correct
   */
  handleBuzzCorrect(message) {
    const { gameId, questionId, buzzerID } = message.payload;

    logger.info(`[Angular] Buzz CORRECT for ${buzzerID}`);

    if (this.gameService) {
      try {
        const result = this.gameService.validateBuzz(gameId, questionId, buzzerID, true);

        this.sendToBuzzer(buzzerID, 'ANSWER_RESULT', {
          questionId,
          isCorrect: true,
          points: result.points,
          responseTime: result.responseTime,
        });

        this.sendToAngular('BUZZ_VALIDATED', {
          buzzerID,
          isCorrect: true,
          points: result.points,
          responseTime: result.responseTime,
        });

        this.broadcastToBuzzers('BUZZER_UNLOCKED', { gameId, questionId });

      } catch (err) {
        logger.error(`Error validating buzz: ${err.message}`);
      }
    }
  }

  /**
   * Angular demande de redonner la main
   */
  handleBuzzReopen(message) {
    const { gameId, questionId, buzzerID } = message.payload;

    logger.info(`[Angular] Reopen buzzer for question ${questionId}, excluding ${buzzerID}`);

    if (this.gameService) {
      try {
        this.gameService.validateBuzz(gameId, questionId, buzzerID, false);
        this.gameService.excludePlayer(gameId, questionId, buzzerID);
      } catch (err) {
        logger.error(`Error reopening buzzer: ${err.message}`);
      }
    }

    // Débloquer tous les buzzers SAUF ceux déjà exclus
    const excludedPlayers = this.gameService
      ? this.gameService.getExcludedPlayers(gameId, questionId)
      : [buzzerID];

    this.buzzerClients.forEach((data, id) => {
      if (!excludedPlayers.includes(id)) {
        this.sendToBuzzer(id, 'BUZZER_UNLOCKED', {
          gameId,
          questionId,
        });
      } else {
        this.sendToBuzzer(id, 'BUZZER_EXCLUDED', {
          gameId,
          questionId,
          reason: 'Mauvaise réponse',
        });
      }
    });

    this.sendToAngular('BUZZ_REOPENED', {
      excludedPlayers,
      remainingPlayers: this.buzzerClients.size - excludedPlayers.length,
    });
  }

  // ═══════════════════════════════════════════════════
  // MESSAGES BUZZER → SERVEUR
  // ═══════════════════════════════════════════════════

  handleBuzzerMessage(buzzerID, ws, message) {
    logger.info(`[${buzzerID}] → ${message.type}`);

    switch (message.type) {
      case 'TIME_SYNC_REQ':
        this.sendToClient(ws, 'TIME_SYNC_RES', {
          T1: message.payload.T1,
          T2: Date.now(),
          T3: Date.now(),
        });
        break;

      case 'PING':
        this.sendToClient(ws, 'PONG', {
          T_send: message.payload.T_send,
          T_receive: Date.now(),
        });
        break;

      case 'STATUS_UPDATE':
        this.handleStatusUpdate(buzzerID, message);
        break;

      case 'ANSWER_MCQ':
        this.handleMCQAnswer(buzzerID, message);
        break;

      case 'ANSWER_BUZZER':
        this.handleBuzzerBuzz(buzzerID, message);
        break;

      default:
        logger.debug(`[${buzzerID}] Unhandled: ${message.type}`);
    }
  }

  /**
   * Mise à jour du statut d'un buzzer
   */
  handleStatusUpdate(buzzerID, message) {
    const buzzerData = this.buzzerClients.get(buzzerID);
    if (buzzerData) {
      buzzerData.info.battery = message.payload.battery;
      buzzerData.info.wifiRSSI = message.payload.wifiRSSI;
    }

    this.sendToAngular('BUZZER_STATUS_UPDATE', {
      buzzerID,
      battery: message.payload.battery,
      wifiRSSI: message.payload.wifiRSSI,
      freeHeap: message.payload.freeHeap,
    });
  }

  /**
   * Gérer une réponse QCM
   */
  handleMCQAnswer(buzzerID, message) {
    const { gameId, questionId, answer, timestamps } = message.payload;

    logger.info(`[${buzzerID}] MCQ answer: question=${questionId}, answer=${answer}`);

    let result = { isCorrect: false, points: 0, responseTime: 0 };

    if (this.gameService) {
      try {
        result = this.gameService.recordAnswer(gameId, questionId, buzzerID, answer, timestamps);
      } catch (err) {
        logger.error(`[${buzzerID}] Error recording MCQ answer: ${err.message}`);
      }
    }

    this.sendToBuzzer(buzzerID, 'ANSWER_RESULT', {
      questionId,
      isCorrect: result.isCorrect,
      points: result.points,
      responseTime: result.responseTime,
    });

    this.sendToAngular('ANSWER_RECEIVED', {
      buzzerID,
      questionId,
      answer,
      isCorrect: result.isCorrect,
      points: result.points,
      responseTime: result.responseTime,
      timestamps,
    });
  }

  /**
   * Gérer un buzz (question de rapidité)
   */
  handleBuzzerBuzz(buzzerID, message) {
    const { gameId, questionId, timestamps } = message.payload;

    logger.info(`[${buzzerID}] BUZZ received for question ${questionId}`);

    if (!this.gameService) {
      logger.error('GameService not available');
      return;
    }

    try {
      const result = this.gameService.recordBuzz(gameId, questionId, buzzerID, timestamps);

      if (result.ignored) {
        logger.info(`[${buzzerID}] Buzz ignored: ${result.reason}`);
        this.sendToBuzzer(buzzerID, 'BUZZ_IGNORED', {
          reason: result.reason,
        });
      }
      // Le gagnant sera notifié via le callback onBuzzWinner
    } catch (err) {
      logger.error(`[${buzzerID}] Error handling buzz: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════
  // UTILITAIRES D'ENVOI
  // ═══════════════════════════════════════════════════

  sendToClient(ws, type, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const message = {
        type,
        timestamp: Date.now(),
        sender: 'SERVER',
        payload,
      };
      ws.send(JSON.stringify(message));
    }
  }

  sendToAngular(type, payload) {
    if (this.angularClient && this.angularClient.readyState === WebSocket.OPEN) {
      this.sendToClient(this.angularClient, type, payload);
    } else {
      logger.debug(`[WebSocket] Angular not connected, cannot send ${type}`);
    }
  }

  sendToBuzzer(buzzerID, type, payload) {
    const buzzerData = this.buzzerClients.get(buzzerID);
    if (buzzerData && buzzerData.ws.readyState === WebSocket.OPEN) {
      this.sendToClient(buzzerData.ws, type, payload);
    } else {
      logger.warn(`[WebSocket] Buzzer ${buzzerID} not available, cannot send ${type}`);
    }
  }

  broadcastToBuzzers(type, payload) {
    let count = 0;
    this.buzzerClients.forEach((data, buzzerID) => {
      this.sendToBuzzer(buzzerID, type, payload);
      count++;
    });
    logger.info(`[WebSocket] Broadcast ${type} to ${count} buzzers`);
  }

  logConnectionStatus() {
    const angularCount = this.angularClient ? 1 : 0;
    const buzzerCount = this.buzzerClients.size;
    logger.info(`[Status] ${angularCount} Angular, ${buzzerCount} Buzzers`);
  }
}

module.exports = WebSocketServer;