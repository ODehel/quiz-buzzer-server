const express = require('express');
const router = express.Router();
const databaseService = require('../services/database.service');
const { authenticateJWT, optionalAuth } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

/**
 * GET /api/jingles
 * Lister tous les jingles
 */
router.get('/', optionalAuth, (req, res) => {
  try {
    const db = databaseService.getDb();
    const jingles = db.prepare('SELECT * FROM jingles ORDER BY name').all();
    res.json(jingles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/jingles/:id
 * Obtenir un jingle par ID
 */
router.get('/:id', optionalAuth, (req, res) => {
  try {
    const db = databaseService.getDb();
    const jingle = db.prepare('SELECT * FROM jingles WHERE id = ?').get(req.params.id);
    if (!jingle) {
      return res.status(404).json({ error: 'Jingle not found' });
    }
    res.json(jingle);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/jingles
 * Créer un jingle (AUTH REQUISE)
 */
router.post('/', authenticateJWT, (req, res) => {
  try {
    const { name, file_path, duration, description } = req.body;

    if (!name || !file_path) {
      return res.status(400).json({ error: 'name and file_path are required' });
    }

    const db = databaseService.getDb();
    const stmt = db.prepare(`
      INSERT INTO jingles (name, file_path, duration, description)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(name, file_path, duration || null, description || null);

    res.status(201).json({
      id: result.lastInsertRowid,
      name,
      file_path,
      duration: duration || null,
      description: description || null,
    });
  } catch (error) {
    logger.error(`Create jingle error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/jingles/:id
 * Modifier un jingle (AUTH REQUISE)
 */
router.put('/:id', authenticateJWT, (req, res) => {
  try {
    const { name, file_path, duration, description } = req.body;
    const db = databaseService.getDb();

    const stmt = db.prepare(`
      UPDATE jingles
      SET name = ?, file_path = ?, duration = ?, description = ?
      WHERE id = ?
    `);
    const result = stmt.run(
      name, file_path,
      duration || null,
      description || null,
      req.params.id
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Jingle not found' });
    }

    res.json({ message: 'Jingle updated' });
  } catch (error) {
    logger.error(`Update jingle error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/jingles/:id
 * Supprimer un jingle (AUTH REQUISE)
 */
router.delete('/:id', authenticateJWT, (req, res) => {
  try {
    const db = databaseService.getDb();
    const result = db.prepare('DELETE FROM jingles WHERE id = ?').run(req.params.id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Jingle not found' });
    }

    res.json({ message: 'Jingle deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
