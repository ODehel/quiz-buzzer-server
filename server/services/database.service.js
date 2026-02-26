const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const logger = require('../utils/logger');

class DatabaseService {
  constructor() {
    this.db = null;
  }

  /**
   * Initialiser la connexion à la base de données
   */
  connect() {
    try {
      // Créer le dossier data s'il n'existe pas
      const dataDir = path.dirname(config.database.path);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      // Connexion à la base de données
      this.db = new Database(config.database.path, {
        verbose: config.server.env === 'development' ? logger.debug : null,
      });

      // Activer les clés étrangères
      this.db.pragma('foreign_keys = ON');

      logger.info('Database connected');

      // Créer les tables si elles n'existent pas
      this.createTables();

      return true;
    } catch (error) {
      logger.error(`Database connection failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Créer les tables
   */
  createTables() {
    try {
      // Table users (pour Windows Hello)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          credential_id TEXT UNIQUE,
          public_key TEXT,
          counter INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Table questions
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS questions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          type TEXT CHECK(type IN ('MCQ', 'BUZZER')) NOT NULL,
          answers TEXT,
          correct_answer INTEGER,
          expected_answer TEXT,
          category TEXT,
          difficulty INTEGER CHECK(difficulty BETWEEN 1 AND 5),
          points INTEGER DEFAULT 10,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Table games
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS games (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          status TEXT CHECK(status IN ('created', 'started', 'paused', 'ended')) DEFAULT 'created',
          settings TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          started_at DATETIME,
          ended_at DATETIME
        )
      `);

      // Table game_questions (liaison many-to-many)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS game_questions (
          game_id TEXT,
          question_id INTEGER,
          question_order INTEGER,
          PRIMARY KEY (game_id, question_id),
          FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
          FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
        )
      `);

      // Table game_results
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS game_results (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          game_id TEXT NOT NULL,
          question_id INTEGER NOT NULL,
          buzzer_id TEXT NOT NULL,
          answer INTEGER,
          is_correct BOOLEAN,
          response_time INTEGER,
          timestamp_local_action INTEGER,
          timestamp_synced_action INTEGER,
          calibrated_latency INTEGER,
          points INTEGER DEFAULT 0,
          rank INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
          FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
        )
      `);

      // Table jingles
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS jingles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          duration INTEGER,
          description TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Index pour performances
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_game_results_game ON game_results(game_id);
        CREATE INDEX IF NOT EXISTS idx_game_results_buzzer ON game_results(buzzer_id);
        CREATE INDEX IF NOT EXISTS idx_questions_type ON questions(type);
        CREATE INDEX IF NOT EXISTS idx_questions_category ON questions(category);
      `);

      logger.info('Database schema ready');

      // Migration : ajouter expected_answer si la colonne n'existe pas déjà
      try {
        this.db.exec(`ALTER TABLE questions ADD COLUMN expected_answer TEXT`);
        logger.info('Migration: added expected_answer column');
      } catch (e) {
        if (!e.message.includes('duplicate column name') && !e.message.includes('already has column')) {
          logger.error(`Migration failed: ${e.message}`);
          throw e;
        }
      }

      // Migration : créer la table jingles si elle n'existe pas déjà
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS jingles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            duration INTEGER,
            description TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);
      } catch (e) {
        logger.error(`Migration jingles failed: ${e.message}`);
        throw e;
      }

      // Insérer des données de démo si la table questions est vide
      this.insertDemoData();
    } catch (error) {
      logger.error(`Failed to create tables: ${error.message}`);
      throw error;
    }
  }

  /**
   * Insérer des données de démonstration
   */
  insertDemoData() {
    const countQuestions = this.db
      .prepare('SELECT COUNT(*) as count FROM questions')
      .get();

    if (countQuestions.count === 0) {
      logger.info('Inserting demo questions...');

      const insertQuestion = this.db.prepare(`
        INSERT INTO questions (text, type, answers, correct_answer, category, difficulty, points)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const demoQuestions = [
        {
          text: 'Quelle est la capitale de la France ?',
          type: 'MCQ',
          answers: JSON.stringify(['Paris', 'Londres', 'Berlin', 'Madrid']),
          correct_answer: 0,
          category: 'Géographie',
          difficulty: 1,
          points: 10,
        },
        {
          text: 'Quel est le plus grand océan du monde ?',
          type: 'MCQ',
          answers: JSON.stringify([
            'Océan Pacifique',
            'Océan Atlantique',
            'Océan Indien',
            'Océan Arctique',
          ]),
          correct_answer: 0,
          category: 'Géographie',
          difficulty: 2,
          points: 10,
        },
        {
          text: 'En quelle année a eu lieu la Révolution française ?',
          type: 'MCQ',
          answers: JSON.stringify(['1789', '1799', '1804', '1815']),
          correct_answer: 0,
          category: 'Histoire',
          difficulty: 2,
          points: 10,
        },
        {
          text: 'Qui a peint la Joconde ?',
          type: 'MCQ',
          answers: JSON.stringify([
            'Léonard de Vinci',
            'Michel-Ange',
            'Raphaël',
            'Botticelli',
          ]),
          correct_answer: 0,
          category: 'Culture',
          difficulty: 1,
          points: 10,
        },
        {
          text: 'Question de rapidité : Citez un pays européen',
          type: 'BUZZER',
          answers: null,
          correct_answer: null,
          category: 'Rapidité',
          difficulty: 1,
          points: 15,
        },
      ];

      const insert = this.db.transaction((questions) => {
        for (const q of questions) {
          insertQuestion.run(
            q.text,
            q.type,
            q.answers,
            q.correct_answer,
            q.category,
            q.difficulty,
            q.points
          );
        }
      });

      insert(demoQuestions);

      logger.info(`Inserted ${demoQuestions.length} demo questions`);
    }

    // Créer un utilisateur admin par défaut
    const countUsers = this.db
      .prepare('SELECT COUNT(*) as count FROM users')
      .get();

    if (countUsers.count === 0) {
      this.db
        .prepare('INSERT INTO users (username) VALUES (?)')
        .run('admin');
      logger.info('Created default admin user');
    }
  }

  /**
   * Obtenir l'instance de la base de données
   */
  getDb() {
    return this.db;
  }

  /**
   * Fermer la connexion
   */
  close() {
    if (this.db) {
      this.db.close();
      logger.info('Database connection closed');
    }
  }
}

// Singleton
const databaseService = new DatabaseService();

module.exports = databaseService;