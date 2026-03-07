import { createServer } from "node:http";
import { getLocalIpAddress } from "./network.js";

const DEFAULT_PORT = 3000;

/**
 * Formate l'heure courante en HH:mm:ss.
 *
 * @param {Date} [now=new Date()] - injectable pour les tests
 * @returns {string}
 */
export function formatTime(now = new Date()) {
  return now.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * Démarre le serveur HTTP avec le routage configuré.
 *
 * @param {Object} options
 * @param {number}   [options.port]     - Port d'écoute
 * @param {Function} [options.log]      - Fonction de log (DIP pour les tests)
 * @param {Function} [options.getIp]    - Résolveur d'IP (DIP pour les tests)
 * @param {Function} [options.requestHandler] - Handler HTTP (DIP pour les tests)
 * @returns {Promise<import("node:http").Server>}
 */
export function startServer({
  port = process.env.PORT !== undefined ? Number(process.env.PORT) : DEFAULT_PORT,
  log = console.log,
  getIp = getLocalIpAddress,
  requestHandler,
} = {}) {
  const handler = requestHandler || ((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  const server = createServer(handler);

  return new Promise((resolve) => {
    server.listen(port, () => {
      const time = formatTime();
      const ip = getIp();

      log(`🚀 Server started at ${time}`);

      if (ip) {
        log(`📡 Listening on http://${ip}:${port}`);
      } else {
        log(`⚠️ No network interface found, listening on http://localhost:${port}`);
      }

      resolve(server);
    });
  });
}