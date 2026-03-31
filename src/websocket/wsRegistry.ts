import Database from "better-sqlite3";
import type { WsRegistryEntry, ParticipantRow } from "../types/index.ts";
import { findActiveGame } from "../repositories/gameanswerRepository.ts";
import { findParticipantsByGameId } from "../repositories/gameRepository.ts";

export const MAX_BUZZERS = 10;

/**
 * Manages the Map of connected WebSocket clients and provides query methods.
 */
export class WsRegistry {
  private readonly registry = new Map<string, WsRegistryEntry>();
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ── Map delegation ────────────────────────────────────────────────────────

  get(sub: string): WsRegistryEntry | undefined {
    return this.registry.get(sub);
  }

  set(sub: string, entry: WsRegistryEntry): void {
    this.registry.set(sub, entry);
  }

  has(sub: string): boolean {
    return this.registry.has(sub);
  }

  delete(sub: string): boolean {
    return this.registry.delete(sub);
  }

  values(): IterableIterator<WsRegistryEntry> {
    return this.registry.values();
  }

  entries(): IterableIterator<[string, WsRegistryEntry]> {
    return this.registry.entries();
  }

  /**
   * Returns the underlying Map (needed by broadcastSystemSoundToBuzzers which
   * expects Map<string, WsRegistryEntry>).
   */
  getMap(): Map<string, WsRegistryEntry> {
    return this.registry;
  }

  // ── Buzzer-order helpers ──────────────────────────────────────────────────

  /**
   * Extracts the 1-based buzzer order from a username like "quiz_buzzer_01".
   * Returns null if the username doesn't match the expected pattern.
   */
  extractBuzzerOrder(username: string): number | null {
    const match = username.match(/^quiz_buzzer_(\d+)$/i);
    if (!match) return null;
    const order = parseInt(match[1], 10);
    return order >= 1 && order <= MAX_BUZZERS ? order : null;
  }

  /**
   * Finds the registry entry for the buzzer assigned to the given participant order.
   * Primary: buzzer quiz_buzzer_XX maps to participant order XX.
   * Fallback: match buzzer username against participant name (case-insensitive).
   */
  findBuzzerEntryByOrder(participantOrder: number): WsRegistryEntry | undefined {
    // Primary: quiz_buzzer_XX -> order XX
    for (const entry of this.registry.values()) {
      if (entry.role === "buzzer" && this.extractBuzzerOrder(entry.username) === participantOrder) {
        return entry;
      }
    }

    // Fallback: match by participant name
    const game = findActiveGame(this.db);
    if (!game) return undefined;

    const participants = findParticipantsByGameId(this.db, game.GAM_ID) as ParticipantRow[];
    const participant = participants.find((p) => p.GPA_ORDER === participantOrder);
    if (!participant) return undefined;

    const targetName = participant.GPA_NAME.toLowerCase();
    for (const entry of this.registry.values()) {
      if (entry.role === "buzzer" && entry.username.toLowerCase() === targetName) {
        return entry;
      }
    }
    return undefined;
  }

  // ── Connection query helpers ──────────────────────────────────────────────

  getConnectedBuzzerUsernames(): string[] {
    return [...this.registry.values()]
      .filter((c) => c.role === "buzzer")
      .map((c) => c.username);
  }

  buzzersConnected(): number {
    return [...this.registry.values()].filter((c) => c.role === "buzzer").length;
  }

  adminConnected(): number {
    return [...this.registry.values()].filter((c) => c.role === "admin").length;
  }

  connectedSummary(): { buzzers_connected: number; buzzers_max: number; admin_connected: number } {
    return {
      buzzers_connected: this.buzzersConnected(),
      buzzers_max: MAX_BUZZERS,
      admin_connected: this.adminConnected(),
    };
  }
}
