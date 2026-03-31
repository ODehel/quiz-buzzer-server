import { networkInterfaces } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";

/**
 * Retourne la première adresse IPv4 locale non-loopback trouvée,
 * ou null si aucune n'est disponible.
 *
 * @param getNetworkInterfaces - injectable pour les tests (DIP)
 */
export function getLocalIpAddress(getNetworkInterfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces): string | null {
  const interfaces = getNetworkInterfaces();

  for (const addresses of Object.values(interfaces)) {
    for (const addr of addresses!) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }

  return null;
}
