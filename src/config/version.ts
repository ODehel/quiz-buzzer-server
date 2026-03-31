import { readFileSync } from "node:fs";
import { logWarn } from "../utils/logger.ts";

let version: string;

try {
  const pkg: { version: string } = JSON.parse(readFileSync("./package.json", "utf8"));
  version = pkg.version;
} catch {
  logWarn("VERSION_READ_FAILED", { message: "Could not read version from package.json, using 'unknown'." });
  version = "unknown";
}

export { version };
