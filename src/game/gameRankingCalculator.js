/**
 * Calcule le classement intermédiaire basé exclusivement sur les scores
 * persistés en base (dernière question complètement terminée).
 *
 * US-014 — CA-6, CA-7, CA-8, CA-9
 */

/**
 * Calcule le classement intermédiaire pour une partie donnée.
 *
 * - Agrège les scores par participant depuis T_GAME_ANSWER_GAA
 * - Jointure avec T_GAME_PARTICIPANT_GPA pour inclure les participants sans réponse
 * - Tri par score cumulé (DESC) puis temps cumulé (ASC)
 * - Ajout du rang (1, 2, 3...)
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} gameId - ID de la partie
 * @returns {Array<{ rank: number, participant_name: string, participant_order: number, cumulative_score: number, total_time_ms: number }>}
 */
export function calculateIntermediateRanking(db, gameId) {
  const rows = db
    .prepare(
      `SELECT
         gpa.GPA_ORDER   AS participant_order,
         gpa.GPA_NAME    AS participant_name,
         COALESCE(MAX(gaa.GAA_CUMULATIVE_SCORE), 0) AS cumulative_score,
         COALESCE(SUM(gaa.GAA_TIME_MS), 0)          AS total_time_ms
       FROM T_GAME_PARTICIPANT_GPA gpa
       LEFT JOIN T_GAME_ANSWER_GAA gaa
         ON gpa.GPA_GAME_ID = gaa.GAA_GAME_ID
         AND gpa.GPA_ORDER  = gaa.GAA_PARTICIPANT_ORDER
       WHERE gpa.GPA_GAME_ID = ?
       GROUP BY gpa.GPA_ORDER, gpa.GPA_NAME
       ORDER BY cumulative_score DESC, total_time_ms ASC`
    )
    .all(gameId);

  return rows.map((row, index) => ({
    rank: index + 1,
    participant_name: row.participant_name,
    participant_order: row.participant_order,
    cumulative_score: row.cumulative_score,
    total_time_ms: row.total_time_ms,
  }));
}
