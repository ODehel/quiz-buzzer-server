const express = require('express');
const router = express.Router();
const authService = require('../services/auth.service');
const logger = require('../utils/logger');

/**
 * POST /api/auth/register/options
 * Générer les options d'enregistrement WebAuthn
 */
router.post('/register/options', async (req, res) => {
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'username is required' });
    }

    const options = await authService.generateRegistrationOptions(username);
    res.json(options);
  } catch (error) {
    logger.error(`Registration options error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/auth/register/verify
 * Vérifier l'enregistrement WebAuthn
 */
router.post('/register/verify', async (req, res) => {
  try {
    const { username, credential } = req.body;

    if (!username || !credential) {
      return res.status(400).json({ error: 'username and credential are required' });
    }

    const verification = await authService.verifyRegistration(username, credential);
    
    res.json({
      verified: verification.verified,
      message: 'Registration successful',
    });
  } catch (error) {
    logger.error(`Registration verification error: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/auth/challenge
 * Générer un challenge d'authentification (ancien endpoint, alias)
 */
router.post('/challenge', async (req, res) => {
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'username is required' });
    }

    const options = await authService.generateAuthenticationOptions(username);
    res.json(options);
  } catch (error) {
    logger.error(`Challenge generation error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/auth/verify
 * Vérifier l'authentification WebAuthn
 */
router.post('/verify', async (req, res) => {
  try {
    const { username, credential } = req.body;

    if (!username || !credential) {
      return res.status(400).json({ error: 'username and credential are required' });
    }

    const result = await authService.verifyAuthentication(username, credential);
    
    res.json({
      success: true,
      token: result.token,
      expiresIn: 3600,
      user: {
        id: result.user.id,
        username: result.user.username,
      },
    });
  } catch (error) {
    logger.error(`Authentication error: ${error.message}`);
    res.status(401).json({ error: error.message });
  }
});

/**
 * POST /api/auth/simple
 * Authentification simple (développement uniquement)
 */
router.post('/simple', (req, res) => {
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'username is required' });
    }

    const result = authService.simpleAuth(username);
    
    res.json({
      success: true,
      token: result.token,
      expiresIn: 3600,
      user: {
        id: result.user.id,
        username: result.user.username,
      },
    });
  } catch (error) {
    logger.error(`Simple auth error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/auth/logout
 * Déconnexion (côté client, suppression du token)
 */
router.post('/logout', (req, res) => {
  // Avec JWT, la déconnexion se fait côté client
  // Le serveur peut optionnellement blacklister le token
  res.json({ message: 'Logged out successfully' });
});

module.exports = router;