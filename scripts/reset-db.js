const fs = require('fs');
const path = require('path');
const config = require('../server/config');
const databaseService = require('../server/services/database.service');

console.log('Resetting database...');

try {
  // Fermer la connexion si elle existe
  databaseService.close();

  // Supprimer le fichier de BDD
  const dbPath = path.resolve(config.database.path);
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    console.log('✓ Old database deleted');
  }

  // Recréer
  databaseService.connect();
  console.log('✓ Database reset successfully');
  process.exit(0);
} catch (error) {
  console.error('✗ Database reset failed:', error.message);
  process.exit(1);
}