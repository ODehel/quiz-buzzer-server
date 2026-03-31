import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Stockage du correlation_id pour la requête/message en cours.
 * Permet de propager le correlation_id sans le passer en paramètre
 * à travers toutes les couches (services, repositories, SQL logging).
 */
const correlationStore = new AsyncLocalStorage<string>();

/**
 * Retourne le correlation_id de la requête/message en cours, ou undefined.
 */
export function getCorrelationId(): string | undefined {
  return correlationStore.getStore();
}

/**
 * Exécute une fonction avec un correlation_id propagé dans le contexte.
 */
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return correlationStore.run(correlationId, fn);
}
