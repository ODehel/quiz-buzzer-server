const { v4: uuidv4 } = require('uuid');
const databaseService = require('./database.service');
const logger = require('../utils/logger');

class GameService {
  constructor() {
    this.activeGames = new Map(); // gameID → gameState
  }

  /**
   * Créer une nouvelle partie
   */
  createGame(name, questionIds, settings = {}) {
    const gameId = 'game_' + uuidv4();
    const db = databaseService.getDb();

    const defaultSettings = {
      mcqDuration: 30000,
      buzzerDuration: 10000,
      showCorrectAnswer: true,
      showIntermediateRanking: true,
      ...settings,
    };

    db.prepare(`
      INSERT INTO games (id, name, status, settings)
      VALUES (?, ?, 'created', ?)
    `).run(gameId, name, JSON.stringify(defaultSettings));

    const insertGameQuestion = db.prepare(`
      INSERT INTO game_questions (game_id, question_id, question_order)
      VALUES (?, ?, ?)
    `);

    const insertQuestions = db.transaction((questions) => {
      questions.forEach((qId, index) => {
        insertGameQuestion.run(gameId, qId, index + 1);
      });
    });

    insertQuestions(questionIds);

    const gameState = {
      id: gameId,
      name,
      status: 'created',
      settings: defaultSettings,
      questionIds,
      currentQuestionIndex: -1,
      questionStartTime: null,
      players: new Map(),
      // Tracker les réponses par question
      currentQuestionAnswers: new Map(), // buzzerID → true (a répondu)
    };

    this.activeGames.set(gameId, gameState);

    logger.info(`Game created: ${gameId} with ${questionIds.length} questions`);
    return gameState;
  }

  /**
   * Démarrer une partie
   */
  startGame(gameId) {
    const game = this.getGame(gameId);

    if (game.status !== 'created') {
      throw new Error('Game already started');
    }

    game.status = 'started';
    game.currentQuestionIndex = 0;
    game.startedAt = Date.now();

    const db = databaseService.getDb();
    db.prepare(`
      UPDATE games 
      SET status = 'started', started_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(gameId);

    logger.info(`Game started: ${gameId}`);
    return game;
  }

  /**
   * Enregistrer un joueur dans la partie
   */
  registerPlayer(gameId, buzzerID, playerName) {
    const game = this.getGame(gameId);

    game.players.set(buzzerID, {
      buzzerID,
      name: playerName,
      score: 0,
      correctAnswers: 0,
      totalAnswers: 0,
      totalResponseTime: 0,
      fastestResponseTime: Infinity,
      slowestResponseTime: 0,
    });

    logger.info(`Player registered: ${playerName} (${buzzerID}) in game ${gameId}`);
  }

  /**
   * Renommer un joueur
   */
  renamePlayer(gameId, buzzerID, newName) {
    const game = this.getGame(gameId);
    const player = game.players.get(buzzerID);

    if (!player) {
      throw new Error('Player not found');
    }

    player.name = newName;
    logger.info(`Player renamed: ${buzzerID} → ${newName}`);
  }

  getCurrentQuestion(gameId) {
  const game = this.getGame(gameId);

  if (game.currentQuestionIndex < 0 || game.currentQuestionIndex >= game.questionIds.length) {
    return null;
  }

  const questionId = game.questionIds[game.currentQuestionIndex];
  const db = databaseService.getDb();
  const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId);

  if (question && question.answers) {
    try {
      question.answers = JSON.parse(question.answers);
    } catch (e) {}
  }

  // Marquer le moment où la question est envoyée
  game.questionStartTime = Date.now();
  game.currentQuestionAnswers = new Map();

  // ⭐ Réinitialiser le tracking des buzzes
  game.currentQuestionBuzzes = [];
  game.currentQuestionExcluded = new Set();
  game.currentQuestionWinner = null;
  game.buzzerLocked = false;
  game.buzzEvaluationTimer = null;

  logger.info(`Question ${questionId} started at ${game.questionStartTime}`);
  return question;
}

  /**
   * ⭐ Enregistrer une réponse avec calcul de temps précis
   */
  recordAnswer(gameId, questionId, buzzerID, answer, timestamps) {
    const game = this.getGame(gameId);
    const db = databaseService.getDb();

    // Vérifier que le joueur n'a pas déjà répondu à cette question
    if (game.currentQuestionAnswers.has(buzzerID)) {
      logger.warn(`${buzzerID} already answered question ${questionId}, ignoring`);
      return { isCorrect: false, points: 0, responseTime: 0, duplicate: true };
    }

    // Récupérer la question
    const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId);
    if (!question) {
      throw new Error('Question not found');
    }

    // Déterminer si la réponse est correcte
    let isCorrect = false;
    if (question.type === 'MCQ') {
      isCorrect = (answer === question.correct_answer);
    } else if (question.type === 'BUZZER') {
      // Pour les questions buzzer, le premier à appuyer gagne
      isCorrect = (game.currentQuestionAnswers.size === 0);
    }

    const points = isCorrect ? (question.points || 10) : 0;

    // ⭐ Calculer le temps de réponse
    // Méthode 1 : Utiliser le timestamp synchronisé du buzzer
    // Méthode 2 : Utiliser le temps serveur comme fallback
    let responseTime = 0;

    if (timestamps && timestamps.timestamp_synced_action && game.questionStartTime) {
      // Temps entre l'envoi de la question et la réponse synchronisée
      responseTime = timestamps.timestamp_synced_action - game.questionStartTime;
    } else if (game.questionStartTime) {
      // Fallback : temps serveur
      responseTime = Date.now() - game.questionStartTime;
    }

    // S'assurer que le temps est positif et raisonnable
    if (responseTime < 0) responseTime = 0;
    if (responseTime > 120000) responseTime = 120000; // Max 2 minutes

    // Marquer que ce buzzer a répondu
    game.currentQuestionAnswers.set(buzzerID, {
      answer,
      isCorrect,
      points,
      responseTime,
      timestamp: Date.now(),
    });

    // Enregistrer dans la BDD
    try {
      db.prepare(`
        INSERT INTO game_results (
          game_id, question_id, buzzer_id, answer, is_correct,
          response_time, timestamp_local_action, timestamp_synced_action,
          calibrated_latency, points
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        gameId,
        questionId,
        buzzerID,
        typeof answer === 'number' ? answer : JSON.stringify(answer),
        isCorrect ? 1 : 0,
        responseTime,
        timestamps ? timestamps.timestamp_local_action : null,
        timestamps ? timestamps.timestamp_synced_action : null,
        timestamps ? timestamps.calibrated_latency : null,
        points
      );
    } catch (err) {
      logger.error(`Error saving result to DB: ${err.message}`);
    }

    // ⭐ Mettre à jour le score du joueur
    const player = game.players.get(buzzerID);
    if (player) {
      player.score += points;
      player.totalAnswers += 1;
      if (isCorrect) {
        player.correctAnswers += 1;
      }
      player.totalResponseTime += responseTime;

      if (responseTime < player.fastestResponseTime) {
        player.fastestResponseTime = responseTime;
      }
      if (responseTime > player.slowestResponseTime) {
        player.slowestResponseTime = responseTime;
      }
    }

    logger.info(
      `[${buzzerID}] answered question ${questionId}: ` +
      `${isCorrect ? 'CORRECT' : 'INCORRECT'}, ` +
      `+${points} pts, ${responseTime}ms`
    );

    return { isCorrect, points, responseTime };
  }

  /**
   * Passer à la question suivante
   */
  nextQuestion(gameId) {
    const game = this.getGame(gameId);

    game.currentQuestionIndex++;
    game.questionStartTime = null;
    game.currentQuestionAnswers = new Map();

    if (game.currentQuestionIndex >= game.questionIds.length) {
      return this.endGame(gameId);
    }

    logger.info(`Game ${gameId}: moving to question ${game.currentQuestionIndex + 1}/${game.questionIds.length}`);
    return { status: 'next', questionIndex: game.currentQuestionIndex };
  }

  /**
   * Terminer la partie
   */
  endGame(gameId) {
    const game = this.getGame(gameId);

    game.status = 'ended';
    game.endedAt = Date.now();

    const db = databaseService.getDb();
    db.prepare(`
      UPDATE games 
      SET status = 'ended', ended_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(gameId);

    logger.info(`Game ended: ${gameId}`);
    return { status: 'ended', id: gameId };
  }

  /**
   * ⭐ Obtenir le classement (trié par score puis par temps de réponse moyen)
   */
  getRanking(gameId) {
    const game = this.getGame(gameId);

    const ranking = Array.from(game.players.values())
      .map(player => {
        const avgResponseTime = player.totalAnswers > 0
          ? Math.round(player.totalResponseTime / player.totalAnswers)
          : 0;

        const fastestTime = player.fastestResponseTime === Infinity
          ? 0
          : player.fastestResponseTime;

        return {
          buzzerID: player.buzzerID,
          name: player.name,
          score: player.score,
          correctAnswers: player.correctAnswers,
          totalAnswers: player.totalAnswers,
          totalResponseTime: player.totalResponseTime,
          avgResponseTime,
          fastestResponseTime: Math.round(fastestTime),
          slowestResponseTime: Math.round(player.slowestResponseTime),
        };
      })
      .sort((a, b) => {
        // ⭐ Critère 1 : Score le plus élevé
        if (b.score !== a.score) {
          return b.score - a.score;
        }

        // ⭐ Critère 2 : Temps de réponse moyen le plus court
        if (a.avgResponseTime !== b.avgResponseTime) {
          return a.avgResponseTime - b.avgResponseTime;
        }

        // ⭐ Critère 3 : Temps de réponse le plus rapide
        return a.fastestResponseTime - b.fastestResponseTime;
      })
      .map((player, index) => ({
        rank: index + 1,
        ...player,
      }));

    return ranking;
  }

  /**
   * Obtenir les statistiques d'une partie depuis la BDD
   */
  getGameStats(gameId) {
    const db = databaseService.getDb();

    const stats = db.prepare(`
      SELECT 
        buzzer_id,
        COUNT(*) as total_answers,
        SUM(CASE WHEN is_correct THEN 1 ELSE 0 END) as correct_answers,
        SUM(points) as total_points,
        AVG(response_time) as avg_response_time,
        MIN(response_time) as min_response_time,
        MAX(response_time) as max_response_time
      FROM game_results
      WHERE game_id = ?
      GROUP BY buzzer_id
      ORDER BY total_points DESC, avg_response_time ASC
    `).all(gameId);

    return stats.map(s => ({
      ...s,
      avg_response_time: Math.round(s.avg_response_time || 0),
      min_response_time: Math.round(s.min_response_time || 0),
      max_response_time: Math.round(s.max_response_time || 0),
    }));
  }

  /**
   * Obtenir un game ou lever une erreur
   */
  getGame(gameId) {
    const game = this.activeGames.get(gameId);
    if (!game) {
      throw new Error(`Game not found: ${gameId}`);
    }
    return game;
  }

  /**
 * ⭐ Enregistrer un buzz et déterminer le gagnant
 */
recordBuzz(gameId, questionId, buzzerID, timestamps) {
  const game = this.getGame(gameId);

  // Initialiser le tracking des buzzes pour cette question si nécessaire
  if (!game.currentQuestionBuzzes) {
    game.currentQuestionBuzzes = [];
    game.currentQuestionExcluded = new Set();
    game.currentQuestionWinner = null;
    game.buzzerLocked = false;
  }

  // Vérifier si ce joueur est exclu (a déjà donné une mauvaise réponse)
  if (game.currentQuestionExcluded.has(buzzerID)) {
    return { ignored: true, reason: 'Joueur exclu pour cette question' };
  }

  // Vérifier si ce joueur a déjà buzzé dans cette "manche"
  const alreadyBuzzed = game.currentQuestionBuzzes.find(
    b => b.buzzerID === buzzerID && !b.processed
  );
  if (alreadyBuzzed) {
    return { ignored: true, reason: 'Déjà buzzé' };
  }

  // Vérifier si les buzzers sont verrouillés (un gagnant a déjà été désigné)
  if (game.buzzerLocked) {
    return { ignored: true, reason: 'Buzzers verrouillés' };
  }

  // Calculer le temps de réponse
  let responseTime = 0;
  if (timestamps && timestamps.timestamp_synced_action && game.questionStartTime) {
    responseTime = timestamps.timestamp_synced_action - game.questionStartTime;
  } else if (game.questionStartTime) {
    responseTime = Date.now() - game.questionStartTime;
  }
  if (responseTime < 0) responseTime = 0;

  // Enregistrer le buzz
  const buzzEntry = {
    buzzerID,
    responseTime,
    timestamps,
    receivedAt: Date.now(),
    processed: false,
  };
  game.currentQuestionBuzzes.push(buzzEntry);

  logger.info(`Buzz from ${buzzerID}: ${responseTime}ms (total buzzes: ${game.currentQuestionBuzzes.length})`);

  // ⭐ Attendre un court délai pour collecter les buzzes quasi-simultanés
  // puis déterminer le gagnant
  if (!game.buzzEvaluationTimer) {
    game.buzzEvaluationTimer = setTimeout(() => {
      this.evaluateBuzzes(gameId, questionId);
      game.buzzEvaluationTimer = null;
    }, 200); // 200ms de fenêtre pour collecter les buzzes simultanés
  }

  // Pour l'instant, signaler que le buzz est enregistré
  // Le résultat définitif viendra après l'évaluation
  const isFirstBuzz = game.currentQuestionBuzzes.filter(b => !b.processed).length === 1;

  return {
    ignored: false,
    isWinner: false, // Sera déterminé dans evaluateBuzzes
    isPending: true,
    responseTime,
    totalBuzzes: game.currentQuestionBuzzes.length,
  };
}

/**
 * ⭐ Évaluer tous les buzzes reçus et déterminer le gagnant
 */
evaluateBuzzes(gameId, questionId) {
  const game = this.getGame(gameId);

  if (!game.currentQuestionBuzzes || game.buzzerLocked) return;

  // Filtrer les buzzes non encore traités et non exclus
  const pendingBuzzes = game.currentQuestionBuzzes.filter(
    b => !b.processed && !game.currentQuestionExcluded.has(b.buzzerID)
  );

  if (pendingBuzzes.length === 0) return;

  // ⭐ Trier par temps de réponse (le plus rapide en premier)
  pendingBuzzes.sort((a, b) => a.responseTime - b.responseTime);

  // Le gagnant est le plus rapide
  const winner = pendingBuzzes[0];
  winner.processed = true;
  game.currentQuestionWinner = winner.buzzerID;
  game.buzzerLocked = true;

  logger.info(`⭐ Buzz winner: ${winner.buzzerID} (${winner.responseTime}ms)`);

  // Marquer les autres comme traités
  pendingBuzzes.slice(1).forEach(b => {
    b.processed = true;
  });

  // Notifier via le callback (sera appelé par le WebSocket server)
  if (this.onBuzzWinner) {
    this.onBuzzWinner(gameId, questionId, winner);
  }
}

/**
 * ⭐ Valider un buzz (correct ou incorrect)
 */
validateBuzz(gameId, questionId, buzzerID, isCorrect) {
  const game = this.getGame(gameId);
  const db = databaseService.getDb();

  const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId);
  const points = isCorrect ? (question ? question.points || 10 : 10) : 0;

  // Trouver le buzz
  const buzzEntry = game.currentQuestionBuzzes
    ? game.currentQuestionBuzzes.find(b => b.buzzerID === buzzerID)
    : null;
  const responseTime = buzzEntry ? buzzEntry.responseTime : 0;

  // Enregistrer dans la BDD
  try {
    db.prepare(`
      INSERT INTO game_results (
        game_id, question_id, buzzer_id, answer, is_correct,
        response_time, timestamp_local_action, timestamp_synced_action,
        calibrated_latency, points
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      gameId,
      questionId,
      buzzerID,
      0, // answer = 0 pour les buzzer
      isCorrect ? 1 : 0,
      responseTime,
      buzzEntry && buzzEntry.timestamps ? buzzEntry.timestamps.timestamp_local_action : null,
      buzzEntry && buzzEntry.timestamps ? buzzEntry.timestamps.timestamp_synced_action : null,
      buzzEntry && buzzEntry.timestamps ? buzzEntry.timestamps.calibrated_latency : null,
      points
    );
  } catch (err) {
    logger.error(`Error saving buzz result: ${err.message}`);
  }

  // Mettre à jour le score du joueur
  const player = game.players.get(buzzerID);
  if (player) {
    player.score += points;
    player.totalAnswers += 1;
    if (isCorrect) {
      player.correctAnswers += 1;
    }
    player.totalResponseTime += responseTime;

    if (responseTime < player.fastestResponseTime) {
      player.fastestResponseTime = responseTime;
    }
    if (responseTime > player.slowestResponseTime) {
      player.slowestResponseTime = responseTime;
    }
  }

  return { isCorrect, points, responseTime };
}

/**
 * ⭐ Exclure un joueur pour la question en cours (mauvaise réponse au buzzer)
 */
excludePlayer(gameId, questionId, buzzerID) {
  const game = this.getGame(gameId);

  if (!game.currentQuestionExcluded) {
    game.currentQuestionExcluded = new Set();
  }

  game.currentQuestionExcluded.add(buzzerID);
  game.buzzerLocked = false;
  game.currentQuestionWinner = null;

  logger.info(`Player ${buzzerID} excluded for question ${questionId}`);
}

/**
 * ⭐ Obtenir la liste des joueurs exclus pour une question
 */
getExcludedPlayers(gameId, questionId) {
  const game = this.getGame(gameId);
  return game.currentQuestionExcluded
    ? Array.from(game.currentQuestionExcluded)
    : [];
}
}

// Singleton
const gameService = new GameService();
module.exports = gameService;