import { networkInterfaces } from "node:os";

/**
 * Retourne la première adresse IPv4 locale non-loopback trouvée,
 * ou null si aucune n'est disponible.
 *
 * @param {Function} [getNetworkInterfaces=networkInterfaces] - injectable pour les tests (DIP)
 * @returns {string|null}
 */
export function getLocalIpAddress(getNetworkInterfaces = networkInterfaces) {
  const interfaces = getNetworkInterfaces();

  for (const addresses of Object.values(interfaces)) {
    for (const addr of addresses) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }

  return null;
}