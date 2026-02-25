const express = require('express');
const router = express.Router();
const gameService = require('../services/game.service');
const rankingService = require('../services/ranking.service');
const { authenticateJWT, optionalAuth } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

/**
 * POST /api/games
 * Créer une nouvelle partie
 */
router.post('/', optionalAuth, (req, res) => {
  try {
    const { name, questionIds, settings } = req.body;

    if (!name || !questionIds || !Array.isArray(questionIds)) {
      return res.status(400).json({ 
        error: 'name and questionIds (array) are required' 
      });
    }

    const game = gameService.createGame(name, questionIds, settings);
    
    res.status(201).json({
      id: game.id,
      name: game.name,
      status: game.status,
      questionCount: game.questionIds.length,
      settings: game.settings,
    });
  } catch (error) {
    logger.error(`Create game error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/games/:id
 * Obtenir les détails d'une partie
 */
router.get('/:id', (req, res) => {
  try {
    const game = gameService.activeGames.get(req.params.id);
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    res.json({
      id: game.id,
      name: game.name,
      status: game.status,
      currentQuestionIndex: game.currentQuestionIndex,
      totalQuestions: game.questionIds.length,
      playerCount: game.players.size,
      players: Array.from(game.players.values()),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/games/:id/start
 * Démarrer une partie
 */
router.post('/:id/start', (req, res) => {
  try {
    const game = gameService.startGame(req.params.id);
    
    res.json({
      id: game.id,
      status: game.status,
      startedAt: game.startedAt,
      message: 'Game started',
    });
  } catch (error) {
    logger.error(`Start game error: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/games/:id/players
 * Enregistrer un joueur dans une partie
 */
router.post('/:id/players', (req, res) => {
  try {
    const { buzzerID, playerName } = req.body;

    if (!buzzerID || !playerName) {
      return res.status(400).json({ 
        error: 'buzzerID and playerName are required' 
      });
    }

    gameService.registerPlayer(req.params.id, buzzerID, playerName);
    
    res.json({
      message: 'Player registered',
      buzzerID,
      playerName,
    });
  } catch (error) {
    logger.error(`Register player error: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

/**
 * PUT /api/games/:id/players/:buzzerID
 * Renommer un joueur
 */
router.put('/:id/players/:buzzerID', (req, res) => {
  try {
    const { newName } = req.body;

    if (!newName) {
      return res.status(400).json({ error: 'newName is required' });
    }

    gameService.renamePlayer(req.params.id, req.params.buzzerID, newName);
    
    res.json({
      message: 'Player renamed',
      buzzerID: req.params.buzzerID,
      newName,
    });
  } catch (error) {
    logger.error(`Rename player error: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/games/:id/current-question
 * Obtenir la question actuelle
 */
router.get('/:id/current-question', (req, res) => {
  try {
    const question = gameService.getCurrentQuestion(req.params.id);
    
    if (!question) {
      return res.status(404).json({ error: 'No current question' });
    }

    res.json(question);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/games/:id/answer
 * Enregistrer une réponse
 */
router.post('/:id/answer', (req, res) => {
  try {
    const { questionId, buzzerID, answer, timestamps } = req.body;

    if (!questionId || !buzzerID || answer === undefined || !timestamps) {
      return res.status(400).json({ 
        error: 'questionId, buzzerID, answer, and timestamps are required' 
      });
    }

    const result = gameService.recordAnswer(
      req.params.id,
      questionId,
      buzzerID,
      answer,
      timestamps
    );
    
    res.json({
      message: 'Answer recorded',
      isCorrect: result.isCorrect,
      points: result.points,
      responseTime: result.responseTime,
    });
  } catch (error) {
    logger.error(`Record answer error: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/games/:id/next-question
 * Passer à la question suivante
 */
router.post('/:id/next-question', (req, res) => {
  try {
    const result = gameService.nextQuestion(req.params.id);
    
    if (result.status === 'ended') {
      return res.json({
        message: 'Game ended',
        status: 'ended',
      });
    }

    res.json({
      message: 'Next question',
      question: result,
    });
  } catch (error) {
    logger.error(`Next question error: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/games/:id/ranking
 * Obtenir le classement
 */
router.get('/:id/ranking', (req, res) => {
  try {
    const ranking = gameService.getRanking(req.params.id);
    res.json(ranking);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/games/:id/stats
 * Obtenir les statistiques
 */
router.get('/:id/stats', (req, res) => {
  try {
    const stats = gameService.getGameStats(req.params.id);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/games/:id/end
 * Terminer une partie
 */
router.post('/:id/end', (req, res) => {
  try {
    const game = gameService.endGame(req.params.id);
    
    res.json({
      message: 'Game ended',
      id: game.id,
      status: game.status,
      endedAt: game.endedAt,
    });
  } catch (error) {
    logger.error(`End game error: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;