import logger from "../config/logger.ts";

export function logInfo(event: string, data: Record<string, unknown>): void {
  logger.info({ event, ...data });
}

export function logWarn(event: string, data: Record<string, unknown>): void {
  logger.warn({ event, ...data });
}

export function logError(event: string, data: Record<string, unknown>): void {
  logger.error({ event, ...data });
}
