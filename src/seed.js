import "dotenv/config";
import bcrypt from "bcrypt";
import { openDatabase } from "./database/database.js";
import { countUsers, insertUser } from "./repositories/userRepository.js";
import { v7 as uuidv7 } from "uuid";

const USERS = [
  { username: "admin", role: "admin", envVar: "SEED_PASSWORD_ADMIN" },
  { username: "quiz_buzzer_01", role: "buzzer", envVar: "SEED_PASSWORD_BUZZER_01" },
  { username: "quiz_buzzer_02", role: "buzzer", envVar: "SEED_PASSWORD_BUZZER_02" },
  { username: "quiz_buzzer_03", role: "buzzer", envVar: "SEED_PASSWORD_BUZZER_03" },
  { username: "quiz_buzzer_04", role: "buzzer", envVar: "SEED_PASSWORD_BUZZER_04" },
  { username: "quiz_buzzer_05", role: "buzzer", envVar: "SEED_PASSWORD_BUZZER_05" },
  { username: "quiz_buzzer_06", role: "buzzer", envVar: "SEED_PASSWORD_BUZZER_06" },
  { username: "quiz_buzzer_07", role: "buzzer", envVar: "SEED_PASSWORD_BUZZER_07" },
  { username: "quiz_buzzer_08", role: "buzzer", envVar: "SEED_PASSWORD_BUZZER_08" },
  { username: "quiz_buzzer_09", role: "buzzer", envVar: "SEED_PASSWORD_BUZZER_09" },
  { username: "quiz_buzzer_10", role: "buzzer", envVar: "SEED_PASSWORD_BUZZER_10" },
];

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 72;

/**
 * Logique de seed extraite pour être testable.
 *
 * @param {Object} deps - Dépendances injectables
 * @param {import("better-sqlite3").Database} deps.db
 * @param {Object} deps.env - Variables d'environnement (source des mots de passe)
 * @param {Function} [deps.generateId=uuidv7] - Générateur d'ID
 * @param {Function} [deps.hashPassword] - Fonction de hachage (bcrypt.hash par défaut)
 * @returns {Promise<{ status: "skipped" | "done", count?: number }>}
 */
export async function runSeed({
  db,
  env,
  generateId = uuidv7,
  hashPassword = (pwd) => bcrypt.hash(pwd, Number(process.env.BCRYPT_COST) || 12),
}) {
  // 1. Idempotent (CA-19)
  if (countUsers(db) > 0) {
    return { status: "skipped" };
  }

  // 2. Lecture et validation des mots de passe (CA-18, CA-20)
  const entries = [];
  for (const user of USERS) {
    const password = env[user.envVar];

    if (!password) {
      throw new Error(`Environment variable ${user.envVar} is not set.`);
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(
        `Password for ${user.username} (${user.envVar}) must be at least ${MIN_PASSWORD_LENGTH} characters (got ${password.length}).`
      );
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      throw new Error(
        `Password for ${user.username} (${user.envVar}) must be at most ${MAX_PASSWORD_LENGTH} characters (got ${password.length}).`
      );
    }

    entries.push({ ...user, password });
  }

  // 3. Hachage (async)
  const hashedEntries = [];
  for (const entry of entries) {
    const hashedPassword = await hashPassword(entry.password);
    hashedEntries.push({ ...entry, hashedPassword });
  }

  // 4. Insertion atomique (CA-17)
  const now = new Date().toISOString();
  const insertAll = db.transaction((items) => {
    for (const entry of items) {
      insertUser(db, {
        id: generateId(),
        username: entry.username,
        password: entry.hashedPassword,
        role: entry.role,
        createdAt: now,
      });
    }
  });

  insertAll(hashedEntries);
  return { status: "done", count: hashedEntries.length };
}

// --- Exécution en tant que script ---
const isMainModule = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

/* istanbul ignore next -- script entry point, tested via `npm run seed` */
if (isMainModule) {
  const db = openDatabase();
  try {
    const result = await runSeed({ db, env: process.env });
    if (result.status === "skipped") {
      console.log("Seed skipped: T_USER_USR table already contains data.");
    } else {
      console.log(`Seed completed: ${result.count} users created successfully.`);
    }
  } catch (err) {
    console.error(`Seed failed: ${err.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}