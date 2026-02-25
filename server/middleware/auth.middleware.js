const authService = require('../services/auth.service');
const logger = require('../utils/logger');

/**
 * Middleware pour vérifier le token JWT
 */
function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization header' });
  }

  const token = authHeader.split(' ')[1]; // Format: "Bearer TOKEN"

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const decoded = authService.verifyJWT(token);

  if (!decoded) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  // Ajouter les infos utilisateur à la requête
  req.user = decoded;
  next();
}

/**
 * Middleware optionnel (ne bloque pas si pas de token)
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (authHeader) {
    const token = authHeader.split(' ')[1];
    const decoded = authService.verifyJWT(token);
    
    if (decoded) {
      req.user = decoded;
    }
  }

  next();
}

module.exports = {
  authenticateJWT,
  optionalAuth,
};