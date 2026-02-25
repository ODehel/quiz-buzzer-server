const databaseService = require('./database.service');
const logger = require('../utils/logger');

class RankingService {
  /**
   * Calculer le classement pour une question de rapidité
   */
  calculateBuzzerRanking(responses) {
    // responses = [{buzzerID, timestamp_synced_action, calibrated_latency}, ...]
    
    // Compenser la latence
    const compensatedResponses = responses.map(r => ({
      ...r,
      compensatedTimestamp: r.timestamp_synced_action - (r.calibrated_latency / 2),
    }));

    // Trier par timestamp compensé
    compensatedResponses.sort((a, b) => a.compensatedTimestamp - b.compensatedTimestamp);

    // Assigner les rangs
    compensatedResponses.forEach((r, index) => {
      r.rank = index + 1;
    });

    logger.debug(`Buzzer ranking calculated for ${responses.length} responses`);
    return compensatedResponses;
  }

  /**
   * Enregistrer les rangs dans la BDD
   */
  saveRanks(gameId, questionId, rankedResponses) {
    const db = databaseService.getDb();
    const updateRank = db.prepare(`
      UPDATE game_results
      SET rank = ?
      WHERE game_id = ? AND question_id = ? AND buzzer_id = ?
    `);

    const updateRanks = db.transaction((responses) => {
      responses.forEach(r => {
        updateRank.run(r.rank, gameId, questionId, r.buzzerID);
      });
    });

    updateRanks(rankedResponses);
    logger.info(`Ranks saved for question ${questionId} in game ${gameId}`);
  }

  /**
   * Obtenir le classement général d'une partie
   */
  getGameRanking(gameId) {
    const db = databaseService.getDb();
    
    const ranking = db.prepare(`
      SELECT 
        buzzer_id,
        SUM(points) as total_points,
        COUNT(*) as total_questions,
        SUM(CASE WHEN is_correct THEN 1 ELSE 0 END) as correct_answers,
        AVG(response_time) as avg_response_time,
        AVG(rank) as avg_rank
      FROM game_results
      WHERE game_id = ?
      GROUP BY buzzer_id
      ORDER BY total_points DESC, avg_response_time ASC
    `).all(gameId);

    return ranking.map((r, index) => ({
      rank: index + 1,
      ...r,
      avg_response_time: Math.round(r.avg_response_time),
      avg_rank: Math.round(r.avg_rank * 10) / 10,
    }));
  }
}

// Singleton
const rankingService = new RankingService();

module.exports = rankingService;