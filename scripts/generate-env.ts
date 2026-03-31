/**
 * Génère un fichier .env à partir de .env.example en remplissant
 * les variables vides avec des valeurs aléatoires sécurisées.
 *
 * Usage :
 *   node --experimental-strip-types scripts/generate-env.ts
 *   npm run generate-env
 */

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE_PATH = resolve(ROOT, ".env.example");
const ENV_PATH = resolve(ROOT, ".env");

if (existsSync(ENV_PATH)) {
  console.error("Le fichier .env existe déjà. Supprimez-le d'abord pour le régénérer.");
  process.exit(1);
}

const example = readFileSync(EXAMPLE_PATH, "utf-8");

const lines = example.split("\n").map((line: string): string => {
  // Conserver les commentaires et les lignes vides tels quels
  if (line.startsWith("#") || !line.includes("=")) return line;

  const eqIndex = line.indexOf("=");
  const key = line.slice(0, eqIndex);
  const value = line.slice(eqIndex + 1);

  // Conserver les valeurs déjà présentes
  if (value.trim()) return line;

  // JWT_SECRET : doit faire au moins 32 caractères
  if (key === "JWT_SECRET") {
    return `${key}=${randomBytes(32).toString("hex")}`;
  }

  // Mots de passe : entre 12 et 72 caractères
  if (key.startsWith("SEED_PASSWORD_")) {
    return `${key}=${randomBytes(12).toString("hex")}`;
  }

  return line;
});

writeFileSync(ENV_PATH, lines.join("\n"), "utf-8");
console.log(`Fichier .env généré avec succès depuis .env.example (${ENV_PATH}).`);
