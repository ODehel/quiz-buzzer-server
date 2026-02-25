const winston = require('winston');
const config = require('../config');
const path = require('path');

// Format personnalisé
const customFormat = winston.format.printf(({ level, message, timestamp }) => {
  return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
});

// Transports (destinations des logs)
const transports = [
  // Console (toujours actif)
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      customFormat
    ),
  }),
];

// Fichiers de logs (si activé)
if (config.logs.toFile) {
  transports.push(
    // Tous les logs
    new winston.transports.File({
      filename: path.join('logs', 'server.log'),
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        customFormat
      ),
      maxsize: 10485760, // 10 MB
      maxFiles: 5,
    }),
    // Erreurs uniquement
    new winston.transports.File({
      filename: path.join('logs', 'error.log'),
      level: 'error',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        customFormat
      ),
      maxsize: 10485760,
      maxFiles: 5,
    })
  );
}

// Créer le logger
const logger = winston.createLogger({
  level: config.logs.level,
  transports,
});

module.exports = logger;