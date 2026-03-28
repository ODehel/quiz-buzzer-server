import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Stockage du correlation_id pour la requête/message en cours.
 * Permet de propager le correlation_id sans le passer en paramètre
 * à travers toutes les couches (services, repositories, SQL logging).
 */
const correlationStore = new AsyncLocalStorage();

/**
 * Retourne le correlation_id de la requête/message en cours, ou undefined.
 * @returns {string|undefined}
 */
export function getCorrelationId() {
  return correlationStore.getStore();
}

/**
 * Exécute une fonction avec un correlation_id propagé dans le contexte.
 * @param {string} correlationId
 * @param {Function} fn
 * @returns {*}
 */
export function runWithCorrelationId(correlationId, fn) {
  return correlationStore.run(correlationId, fn);
}
