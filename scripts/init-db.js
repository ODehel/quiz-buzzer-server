const databaseService = require('../server/services/database.service');

console.log('Initializing database...');

try {
  databaseService.connect();
  console.log('✓ Database initialized successfully');
  process.exit(0);
} catch (error) {
  console.error('✗ Database initialization failed:', error.message);
  process.exit(1);
}