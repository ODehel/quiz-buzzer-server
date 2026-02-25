require('dotenv').config();

module.exports = {
  // Serveur
  server: {
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT, 10) || 3000,
    host: process.env.HOST || '0.0.0.0',
  },

  // Base de données
  database: {
    path: process.env.DATABASE_PATH || './data/quizbuzzer.db',
  },

  // Authentification
  auth: {
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiry: process.env.JWT_EXPIRY || '1h',
    rpId: process.env.RP_ID || 'localhost',
    rpName: process.env.RP_NAME || 'QuizBuzzer',
    rpOrigin: process.env.RP_ORIGIN || 'http://localhost:4200',
  },

  // CORS
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:4200',
  },

  // Jeu
  game: {
    maxBuzzers: parseInt(process.env.MAX_BUZZERS, 10) || 10,
    mcqDuration: parseInt(process.env.MCQ_DURATION, 10) || 30000,
    buzzerDuration: parseInt(process.env.BUZZER_DURATION, 10) || 10000,
  },

  // Logs
  logs: {
    level: process.env.LOG_LEVEL || 'info',
    toFile: process.env.LOG_TO_FILE === 'true',
  },
};