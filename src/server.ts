import { createServer } from "node:http";
import { IncomingMessage, ServerResponse, Server } from "node:http";
import { getLocalIpAddress } from "./network.ts";
import type { StartServerOptions } from "./types/index.ts";

const DEFAULT_PORT = 3000;

/**
 * Formate l'heure courante en HH:mm:ss.
 */
export function formatTime(now: Date = new Date()): string {
  return now.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * Démarre le serveur HTTP avec le routage configuré.
 */
export function startServer({
  port = process.env.PORT !== undefined ? Number(process.env.PORT) : DEFAULT_PORT,
  log = console.log,
  getIp = getLocalIpAddress,
  requestHandler,
}: StartServerOptions = {}): Promise<Server> {
  const handler = requestHandler || ((_req: IncomingMessage, res: ServerResponse) => {
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
