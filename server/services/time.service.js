const logger = require('../utils/logger');

class TimeService {
  /**
   * Traiter une requête de synchronisation NTP
   */
  handleTimeSyncRequest(clientTimestamp) {
    const T1 = clientTimestamp; // Temps client envoi
    const T2 = Date.now();       // Temps serveur réception
    const T3 = Date.now();       // Temps serveur envoi (immédiat)

    return {
      T1,
      T2,
      T3,
      serverTime: T3,
    };
  }

  /**
   * Calculer l'offset client (à faire côté client)
   * offset = ((T2 - T1) + (T3 - T4)) / 2
   */
  calculateOffset(T1, T2, T3, T4) {
    return Math.round(((T2 - T1) + (T3 - T4)) / 2);
  }

  /**
   * Traiter un PING pour calibration de latence
   */
  handlePing(pingTimestamp) {
    return {
      pongTimestamp: Date.now(),
      pingTimestamp,
    };
  }

  /**
   * Vérifier que les timestamps sont dans une plage acceptable
   */
  validateTimestamp(timestamp, maxDrift = 60000) {
    const now = Date.now();
    const drift = Math.abs(now - timestamp);

    if (drift > maxDrift) {
      logger.warn(`Large timestamp drift detected: ${drift}ms`);
      return false;
    }

    return true;
  }
}

// Singleton
const timeService = new TimeService();

module.exports = timeService;