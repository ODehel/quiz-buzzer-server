const express = require('express');
const router = express.Router();
const databaseService = require('../services/database.service');
const { authenticateJWT, optionalAuth } = require('../middleware/auth.middleware');

/**
 * GET /api/questions
 * Récupérer toutes les questions (pas besoin d'auth)
 */
router.get('/', optionalAuth, (req, res) => {
  try {
    const db = databaseService.getDb();
    const questions = db.prepare('SELECT * FROM questions ORDER BY id').all();

    questions.forEach((q) => {
      if (q.answers) {
        q.answers = JSON.parse(q.answers);
      }
    });

    res.json(questions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/questions
 * Créer une question (AUTH REQUISE)
 */
router.post('/', authenticateJWT, (req, res) => {
  try {
    const { text, type, answers, correct_answer, expected_answer, category, difficulty, points } = req.body;

    if (!text || !type) {
      return res.status(400).json({ error: 'text and type are required' });
    }

    if (!['MCQ', 'BUZZER'].includes(type)) {
      return res.status(400).json({ error: 'type must be MCQ or BUZZER' });
    }

    const db = databaseService.getDb();
    const stmt = db.prepare(`
      INSERT INTO questions (text, type, answers, correct_answer, expected_answer, category, difficulty, points)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      text,
      type,
      answers ? JSON.stringify(answers) : null,
      correct_answer ?? null,
      expected_answer ?? null,
      category || null,
      difficulty || 3,
      points || 10
    );

    res.status(201).json({
      id: result.lastInsertRowid,
      message: 'Question created',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/questions/:id
 * Mettre à jour une question (AUTH REQUISE)
 */
router.put('/:id', authenticateJWT, (req, res) => {
  try {
    const { text, type, answers, correct_answer, expected_answer, category, difficulty, points } = req.body;
    const db = databaseService.getDb();

    const stmt = db.prepare(`
      UPDATE questions 
      SET text = ?, type = ?, answers = ?, correct_answer = ?, expected_answer = ?,
          category = ?, difficulty = ?, points = ?
      WHERE id = ?
    `);

    const result = stmt.run(
      text, type,
      answers ? JSON.stringify(answers) : null,
      correct_answer ?? null,
      expected_answer ?? null,
      category || null,
      difficulty || 3,
      points || 10,
      req.params.id
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Question not found' });
    }

    res.json({ message: 'Question updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/questions/:id
 * Supprimer une question (AUTH REQUISE)
 */
router.delete('/:id', authenticateJWT, (req, res) => {
  try {
    const db = databaseService.getDb();
    const stmt = db.prepare('DELETE FROM questions WHERE id = ?');
    const result = stmt.run(req.params.id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Question not found' });
    }

    res.json({ message: 'Question deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Autres routes...

module.exports = router;