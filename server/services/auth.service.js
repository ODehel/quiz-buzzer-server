const jwt = require('jsonwebtoken');
const { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');
const config = require('../config');
const databaseService = require('./database.service');
const logger = require('../utils/logger');

class AuthService {
  constructor() {
    // Stockage temporaire des challenges (en production, utiliser Redis)
    this.challenges = new Map();
  }

  /**
   * Authentification simple (pour développement, sans Windows Hello)
   */
  simpleAuth(username) {
    const db = databaseService.getDb();

    // Créer l'utilisateur s'il n'existe pas
    let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

    if (!user) {
      const result = db.prepare(
        'INSERT INTO users (username) VALUES (?)'
      ).run(username);
      user = { id: result.lastInsertRowid, username };
    }

    const token = this.generateJWT(user.id, user.username);

    logger.info(`Simple auth for ${username}`);

    return { token, user };
  }

  /**
   * Générer un token JWT
   */
  generateJWT(userId, username) {
    const payload = {
      userId,
      username,
      iat: Date.now(),
    };

    return jwt.sign(payload, config.auth.jwtSecret, {
      expiresIn: config.auth.jwtExpiry,
    });
  }

  /**
   * Vérifier un token JWT
   */
  verifyJWT(token) {
    try {
      return jwt.verify(token, config.auth.jwtSecret);
    } catch (error) {
      logger.error(`JWT verification failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Générer les options d'enregistrement WebAuthn
   */
  async generateRegistrationOptions(username) {
    const db = databaseService.getDb();
    
    // Vérifier si l'utilisateur existe
    let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    
    if (!user) {
      // Créer un nouvel utilisateur
      const result = db.prepare('INSERT INTO users (username) VALUES (?)').run(username);
      user = { id: result.lastInsertRowid, username };
    }

    const options = await generateRegistrationOptions({
      rpName: config.auth.rpName,
      rpID: config.auth.rpId,
      userID: user.id.toString(),
      userName: username,
      timeout: 60000,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'discouraged',
        userVerification: 'preferred',
      },
    });

    // Stocker le challenge temporairement
    this.challenges.set(username, options.challenge);

    logger.info(`Registration options generated for ${username}`);
    return options;
  }

  /**
   * Vérifier l'enregistrement WebAuthn
   */
  async verifyRegistration(username, credential) {
    const expectedChallenge = this.challenges.get(username);
    
    if (!expectedChallenge) {
      throw new Error('Challenge not found or expired');
    }

    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: config.auth.rpOrigin,
      expectedRPID: config.auth.rpId,
    });

    if (!verification.verified) {
      throw new Error('Registration verification failed');
    }

    // Stocker la credential dans la base de données
    const db = databaseService.getDb();
    const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;

    db.prepare(`
      UPDATE users 
      SET credential_id = ?, public_key = ?, counter = ?
      WHERE username = ?
    `).run(
      Buffer.from(credentialID).toString('base64'),
      Buffer.from(credentialPublicKey).toString('base64'),
      counter,
      username
    );

    // Supprimer le challenge
    this.challenges.delete(username);

    logger.info(`Registration verified for ${username}`);
    
    return verification;
  }

  /**
   * Générer les options d'authentification WebAuthn
   */
  async generateAuthenticationOptions(username) {
    const db = databaseService.getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

    if (!user || !user.credential_id) {
      throw new Error('User not registered');
    }

    const options = await generateAuthenticationOptions({
      timeout: 60000,
      allowCredentials: [{
        id: Buffer.from(user.credential_id, 'base64'),
        type: 'public-key',
      }],
      userVerification: 'preferred',
      rpID: config.auth.rpId,
    });

    // Stocker le challenge
    this.challenges.set(username, options.challenge);

    logger.info(`Authentication options generated for ${username}`);
    return options;
  }

  /**
   * Vérifier l'authentification WebAuthn
   */
  async verifyAuthentication(username, credential) {
    const db = databaseService.getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

    if (!user) {
      throw new Error('User not found');
    }

    const expectedChallenge = this.challenges.get(username);
    
    if (!expectedChallenge) {
      throw new Error('Challenge not found or expired');
    }

    const authenticator = {
      credentialID: Buffer.from(user.credential_id, 'base64'),
      credentialPublicKey: Buffer.from(user.public_key, 'base64'),
      counter: user.counter,
    };

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: config.auth.rpOrigin,
      expectedRPID: config.auth.rpId,
      authenticator,
    });

    if (!verification.verified) {
      throw new Error('Authentication verification failed');
    }

    // Mettre à jour le counter
    db.prepare('UPDATE users SET counter = ? WHERE id = ?')
      .run(verification.authenticationInfo.newCounter, user.id);

    // Supprimer le challenge
    this.challenges.delete(username);

    logger.info(`Authentication verified for ${username}`);

    // Générer un JWT
    const token = this.generateJWT(user.id, user.username);

    return { token, user };
  }

  /**
   * Authentification simple (pour développement, sans Windows Hello)
   */
  simpleAuth(username) {
    const db = databaseService.getDb();
    let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

    if (!user) {
      const result = db.prepare('INSERT INTO users (username) VALUES (?)').run(username);
      user = { id: result.lastInsertRowid, username };
    }

    const token = this.generateJWT(user.id, user.username);
    
    logger.info(`Simple auth for ${username}`);
    return { token, user };
  }
}

// Singleton
const authService = new AuthService();

module.exports = authService;