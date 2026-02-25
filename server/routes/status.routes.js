const express = require('express');
const router = express.Router();
const databaseService = require('../services/database.service');

/**
 * GET /api/status
 * Vérifier l'état du serveur
 */
router.get('/', (req, res) => {
  try {
    const db = databaseService.getDb();

    // Compter les questions
    const questionsCount = db
      .prepare('SELECT COUNT(*) as count FROM questions')
      .get().count;

    // Compter les parties
    const gamesCount = db
      .prepare('SELECT COUNT(*) as count FROM games')
      .get().count;

    res.json({
      status: 'ok',
      version: '1.0.0',
      uptime: process.uptime(),
      timestamp: Date.now(),
      database: {
        status: 'connected',
        questions: questionsCount,
        games: gamesCount,
      },
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
    });
  }
});

module.exports = router;