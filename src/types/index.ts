/**
 * Types partagés du projet Quiz Buzzer Server.
 *
 * Principes SOLID appliqués :
 * - ISP (Interface Segregation) : interfaces découpées par domaine
 * - DIP (Dependency Inversion) : les modules dépendent d'abstractions, pas de concrets
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "node:http";
import Database from "better-sqlite3";

// ── Configuration ────────────────────────────────────────────────────────────

export interface AppConfig {
  jwtSecret: string;
  jwtExpiration: number;
  port: number;
  serverBaseUrl: string;
}

// ── HTTP Request/Response ────────────────────────────────────────────────────

export interface AppRequest extends IncomingMessage {
  user?: JwtPayload;
  correlationId?: string;
  body?: unknown;
}

export interface RouteHandler {
  (req: AppRequest, res: ServerResponse, url: URL): void | Promise<void>;
}

export interface RouteEntry {
  path: string | RegExp;
  method?: string;
  handler: RouteHandler;
}

// ── Authentication & JWT ─────────────────────────────────────────────────────

export interface JwtPayload {
  sub: string;
  role: string;
  iat: number;
  exp: number;
}

export interface TokenResult {
  token: string;
  expires_in: number;
  token_type: string;
}

export interface AuthMiddleware {
  (req: AppRequest): void;
}

export interface AuthorizeMiddleware {
  (req: AppRequest): void;
}

// ── Rate Limiting (ISP) ─────────────────────────────────────────────────────

export interface RateLimitCheck {
  allowed: boolean;
  retryAfter?: number;
}

export interface IRateLimiter {
  check(ip: string): RateLimitCheck;
  reset(): void;
}

// ── Database Row Types ──────────────────────────────────────────────────────

export interface UserRow {
  USR_ID: string;
  USR_USERNAME: string;
  USR_PASSWORD: string;
  USR_ROLE: string;
  USR_CREATED_AT: string;
  USR_LAST_UPDATED_AT: string | null;
}

export interface ThemeRow {
  THM_ID: string;
  THM_NAME: string;
  THM_CREATED_AT: string;
  THM_LAST_UPDATED_AT: string | null;
}

export interface QuestionRow {
  QST_ID: string;
  QST_TYPE: "MCQ" | "SPEED";
  QST_THEME_ID: string;
  QST_TITLE: string;
  QST_CHOICE_A: string | null;
  QST_CHOICE_B: string | null;
  QST_CHOICE_C: string | null;
  QST_CHOICE_D: string | null;
  QST_CORRECT_ANSWER: string;
  QST_LEVEL: number;
  QST_TIME_LIMIT: number;
  QST_POINTS: number;
  QST_IMAGE_PATH: string | null;
  QST_AUDIO_PATH: string | null;
  QST_CREATED_AT: string;
  QST_LAST_UPDATED_AT: string | null;
  THM_NAME?: string | null;
}

export interface QuizRow {
  QUZ_ID: string;
  QUZ_NAME: string;
  QUZ_CREATED_AT: string;
  QUZ_LAST_UPDATED_AT: string | null;
}

export interface QuizQuestionRow {
  QQN_QUIZ_ID: string;
  QQN_QUESTION_ID: string;
  QQN_ORDER: number;
}

export interface GameRow {
  GAM_ID: string;
  GAM_QUIZ_ID: string;
  GAM_STATUS: GameStatus;
  GAM_CURRENT_QUESTION_INDEX: number;
  GAM_CREATED_AT: string;
  GAM_LAST_UPDATED_AT: string | null;
}

export interface ParticipantRow {
  GPA_GAME_ID?: string;
  GPA_ORDER: number;
  GPA_NAME: string;
}

export interface SoundRow {
  SND_ID: string;
  SND_NAME: string;
  SND_FILENAME: string;
  SND_CREATED_AT: string;
}

export interface GameAnswerRow {
  GAA_ID: string;
  GAA_GAME_ID: string;
  GAA_QUESTION_ID: string;
  GAA_PARTICIPANT_ORDER: number;
  GAA_ANSWER: string | null;
  GAA_TIME_MS: number;
  GAA_POINTS_EARNED: number;
  GAA_CUMULATIVE_SCORE: number;
  GAA_CREATED_AT: string;
}

// ── Game Status Machine ─────────────────────────────────────────────────────

export type GameStatus =
  | "PENDING"
  | "OPEN"
  | "QUESTION_TITLE"
  | "QUESTION_OPEN"
  | "QUESTION_BUZZED"
  | "QUESTION_CLOSED"
  | "COMPLETED"
  | "IN_ERROR";

export type QuestionType = "MCQ" | "SPEED";

// ── API Response Types ──────────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

export interface ThemeApiResponse {
  id: string;
  name: string;
  created_at: string;
  last_updated_at: string | null;
}

export interface QuestionApiResponse {
  id: string;
  type: QuestionType;
  theme_id: string;
  theme_name: string | null;
  title: string;
  choices?: string[];
  correct_answer: string;
  level: number;
  time_limit: number;
  points: number;
  image_path: string | null;
  audio_path: string | null;
  created_at: string;
  last_updated_at: string | null;
}

export interface SoundApiResponse {
  id: string;
  name: string;
  filename: string;
  url: string;
  created_at: string;
}

export interface GameApiResponse {
  id: string;
  quiz_id: string;
  status: string;
  created_at: string;
  last_updated_at: string | null;
  participants: Array<{ order: number; name: string }>;
}

// ── Game Orchestrator (ISP — interfaces séparées par rôle) ──────────────────

export interface GameSender {
  broadcast(msg: WsMessage): void;
  sendToAdmin(msg: WsMessage): void;
  sendToBuzzer(participantOrder: number, msg: WsMessage): void;
  sendSystemSoundToBuzzer?(participantOrder: number, soundId: string): void;
  broadcastSystemSound?(soundId: string): void;
}

export interface OrchestratorResult {
  ok: boolean;
  error?: { code: string; message: string };
}

export interface GameOrchestrator {
  handleTriggerTitle(): OrchestratorResult;
  handleTriggerChoices(): OrchestratorResult;
  handleTriggerCorrection(): OrchestratorResult | Promise<OrchestratorResult>;
  handleTriggerNextQuestion(): OrchestratorResult;
  handleAnswer(participantOrder: number, answer: string, timeMs: number): AnswerResult;
  handleBuzz(sub: string, username: string, participantOrder: number): BuzzResult;
  handleValidateAnswer(): OrchestratorResult | Promise<OrchestratorResult>;
  handleInvalidateAnswer(): OrchestratorResult | Promise<OrchestratorResult>;
  handleTriggerIntermediateRanking(): OrchestratorResult;
  getTimerInfo(): TimerInfo | null;
  cleanupGameState(): void;
}

// ── Timer ───────────────────────────────────────────────────────────────────

export interface TimerInfo {
  startedAt: string;
  timeLimit: number;
}

export interface IGameTimer {
  start(): { startedAt: string };
  stop(): void;
  isRunning(): boolean;
  suspend(): number;
  resume(): void;
  getRemainingMs(): number;
}

// ── Answer Processing ───────────────────────────────────────────────────────

export interface AnswerResult {
  accepted: boolean;
  participantOrder?: number;
  answer?: string;
  timeMs?: number;
  reason?: string;
}

export interface BuzzResult {
  accepted: boolean;
  reason?: string;
}

export interface QuestionResult {
  questionId: string;
  participantOrder: number;
  answer: string | null;
  timeMs: number;
  correct: boolean;
  pointsEarned: number;
  cumulativeScore: number;
}

export interface RankingEntry {
  rank: number;
  participantOrder: number;
  cumulativeScore: number;
  totalTimeMs: number;
}

// ── Game Answer Persistence ─────────────────────────────────────────────────

export interface GameAnswerData {
  id: string;
  gameId: string;
  questionId: string;
  participantOrder: number;
  answer: string | null;
  timeMs: number;
  pointsEarned: number;
  cumulativeScore: number;
  createdAt: string;
}

// ── Seed Types ──────────────────────────────────────────────────────────────

export interface SeedUser {
  username: string;
  role: string;
  envVar: string;
}

export interface SeedDeps {
  db: Database.Database;
  env: Record<string, string | undefined>;
  generateId?: () => string;
  hashPassword?: (pwd: string) => Promise<string>;
}

export interface SeedResult {
  status: "skipped" | "done";
  count?: number;
}

// ── WebSocket Messages ──────────────────────────────────────────────────────

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

export interface WsRegistryEntry {
  ws: import("ws").WebSocket;
  role: string;
  username: string;
  connectedAt: string;
  tokenExpiringSoonTimer?: ReturnType<typeof setTimeout>;
  tokenExpiredTimer?: ReturnType<typeof setTimeout>;
}

// ── Upload Types ────────────────────────────────────────────────────────────

export interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

export interface MultipartResult {
  type: string;
  file: UploadedFile;
}

export interface SoundMultipartResult {
  name: string;
  file: UploadedFile;
}

// ── Server ──────────────────────────────────────────────────────────────────

export interface StartServerOptions {
  port?: number;
  log?: (...args: unknown[]) => void;
  getIp?: () => string | null;
  requestHandler?: (req: IncomingMessage, res: ServerResponse) => void;
}

// ── Orchestrator Context (DIP — inversion de dépendances) ───────────────────

export interface OrchestratorContext {
  db: Database.Database;
  sender: GameSender;
  persistFn?: (answers: GameAnswerData[]) => void;
  retryOptions?: { maxRetries?: number; baseDelayMs?: number };
  errorResult(code: string, message: string): OrchestratorResult;
  okResult(data?: Record<string, unknown>): OrchestratorResult;
  loadActiveGame(): GameRow | undefined;
  loadParticipantNames(gameId: string): Record<number, string>;
  loadCumulativeScores(gameId: string, orders: number[]): Record<number, number>;
  cleanupTimer(): void;
  getTimer(): IGameTimer | null;
  setTimer(t: IGameTimer | null): void;
  getProcessor(): IAnswerProcessor | null;
  setProcessor(p: IAnswerProcessor | null): void;
  getSpeedProcessor(): ISpeedProcessor | null;
  setSpeedProcessor(p: ISpeedProcessor | null): void;
  getTimerInfo(): TimerInfo | null;
  setTimerInfo(info: TimerInfo | null): void;
  getCurrentQuestion(): QuestionRow | null;
  setCurrentQuestion(q: QuestionRow | null): void;
}

// ── Answer Processor Interface (ISP) ────────────────────────────────────────

export interface IAnswerProcessor {
  recordAnswer(participantOrder: number, answer: string, timeMs: number): AnswerResult;
  allAnswered(): boolean;
  hasAnswered(participantOrder: number): boolean;
  getResults(): QuestionResult[];
  getRanking(): RankingEntry[];
  expire(): void;
  isExpired(): boolean;
}

// ── Speed Processor Interface (ISP) ─────────────────────────────────────────

export interface ISpeedProcessor {
  recordBuzz(sub: string, username: string, participantOrder: number, timeMsAtBuzz: number): BuzzResult;
  getCurrentBuzzer(): { sub: string; username: string; participantOrder: number; timeMsAtBuzz: number } | null;
  validate(): { participantOrder: number; timeMsAtBuzz: number; pointsEarned: number; cumulativeScore: number };
  invalidate(): { participantOrder: number; hasAvailablePlayers: boolean };
  hasAvailablePlayers(): boolean;
  setTimerExpiredDuringBuzz(): void;
  hasTimerExpiredDuringBuzz(): boolean;
  getInvalidated(): Set<number>;
  getResults(): Array<{ participantOrder: number; correctAnswer: string; correct: boolean; pointsEarned: number; cumulativeScore: number }>;
  getSummary(names: Record<number, string>): { winner: unknown; buzzers: unknown[]; ranking: unknown[] };
}

// ── Heartbeat Options ───────────────────────────────────────────────────────

export interface HeartbeatOptions {
  intervalMs?: number;
  maxMissed?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  ip?: string;
}

// ── Game Sync Options ───────────────────────────────────────────────────────

export interface GameSyncOptions {
  getTimerInfo?: () => TimerInfo | null;
  connectedBuzzerUsernames?: string[];
  sendFn?: (msg: WsMessage) => void;
}
