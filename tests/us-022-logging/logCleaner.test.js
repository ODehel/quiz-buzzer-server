import { jest } from "@jest/globals";
import { mkdirSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import logger from "../../src/config/logger.js";
import { cleanOldLogs } from "../../src/utils/logCleaner.js";

// =============================================================================
// CA-13, CA-15, CA-29 to CA-31: Log cleaner tests
// =============================================================================

describe("cleanOldLogs", () => {
  let tempDir;
  let infoSpy;
  let warnSpy;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "logcleaner-test-"));
    infoSpy = jest.spyOn(logger, "info");
    warnSpy = jest.spyOn(logger, "warn");
  });

  afterEach(async () => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    if (tempDir && existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // CA-30: Empty directory returns deleted_count: 0
  it("should return 0 when directory is empty (CA-30)", async () => {
    const result = await cleanOldLogs(tempDir);

    expect(result).toBe(0);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "LOGS_CLEANUP_DONE",
        deleted_count: 0,
      })
    );
  });

  // CA-29/CA-13: Files older than 7 days are deleted
  it("should delete log files older than 7 days (CA-29, CA-13)", async () => {
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000);

    // Create old log files
    const oldFile1 = join(tempDir, "app-2026-03-01T10.log");
    const oldFile2 = join(tempDir, "app-2026-03-02T14.log");
    writeFileSync(oldFile1, "old log content");
    writeFileSync(oldFile2, "old log content");

    // Set modification time to 8 days ago
    utimesSync(oldFile1, eightDaysAgo, eightDaysAgo);
    utimesSync(oldFile2, eightDaysAgo, eightDaysAgo);

    const result = await cleanOldLogs(tempDir, now);

    expect(result).toBe(2);
    expect(existsSync(oldFile1)).toBe(false);
    expect(existsSync(oldFile2)).toBe(false);
  });

  it("should NOT delete log files newer than 7 days", async () => {
    const now = Date.now();
    const recentFile = join(tempDir, "app-2026-03-27T10.log");
    writeFileSync(recentFile, "recent log content");
    // Recent file keeps its current mtime which is less than 7 days old

    const result = await cleanOldLogs(tempDir, now);

    expect(result).toBe(0);
    expect(existsSync(recentFile)).toBe(true);
  });

  it("should only target files matching app-*.log pattern", async () => {
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000);

    // Non-matching files
    const otherFile = join(tempDir, "other.log");
    const txtFile = join(tempDir, "app-data.txt");
    writeFileSync(otherFile, "content");
    writeFileSync(txtFile, "content");
    utimesSync(otherFile, eightDaysAgo, eightDaysAgo);
    utimesSync(txtFile, eightDaysAgo, eightDaysAgo);

    // Matching file
    const logFile = join(tempDir, "app-2026-03-01T10.log");
    writeFileSync(logFile, "content");
    utimesSync(logFile, eightDaysAgo, eightDaysAgo);

    const result = await cleanOldLogs(tempDir, now);

    expect(result).toBe(1);
    // Non-matching files remain
    expect(existsSync(otherFile)).toBe(true);
    expect(existsSync(txtFile)).toBe(true);
  });

  it("should handle a mix of old and new log files", async () => {
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000);

    const oldFile = join(tempDir, "app-2026-03-01T10.log");
    const newFile = join(tempDir, "app-2026-03-27T10.log");
    writeFileSync(oldFile, "old");
    writeFileSync(newFile, "new");
    utimesSync(oldFile, eightDaysAgo, eightDaysAgo);

    const result = await cleanOldLogs(tempDir, now);

    expect(result).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
  });

  // CA-31: Failed deletion logs WARN and continues
  it("should log WARN and continue when a file deletion fails (CA-31)", async () => {
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000);

    // Create a subdirectory named like a log file to cause unlink to fail
    const badFile = join(tempDir, "app-2026-03-01T10.log");
    mkdirSync(badFile); // unlink fails on directories

    // Also set mtime to old via the directory
    utimesSync(badFile, eightDaysAgo, eightDaysAgo);

    // Create a valid old file that should still be deleted
    const goodFile = join(tempDir, "app-2026-03-02T10.log");
    writeFileSync(goodFile, "content");
    utimesSync(goodFile, eightDaysAgo, eightDaysAgo);

    const result = await cleanOldLogs(tempDir, now);

    // The good file should have been deleted despite the bad file failure
    expect(existsSync(goodFile)).toBe(false);
    // WARN should have been logged for the bad file
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "LOGS_CLEANUP_FILE_ERROR",
        file: "app-2026-03-01T10.log",
      })
    );
    // result should count only the successfully deleted files
    expect(result).toBe(1);
  });

  it("should return 0 when directory does not exist", async () => {
    const result = await cleanOldLogs("/nonexistent/path/to/logs");

    expect(result).toBe(0);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "LOGS_CLEANUP_DONE",
        deleted_count: 0,
      })
    );
  });

  // CA-15: In test env, function itself works but should not be called from index.js.
  // We verify the function is callable in test env (it's index.js that guards the call).
  it("should be callable in test environment (CA-15 guard is in index.js)", async () => {
    expect(process.env.NODE_ENV).toBe("test");
    const result = await cleanOldLogs(tempDir);
    expect(typeof result).toBe("number");
  });

  it("should log LOGS_CLEANUP_DONE with deleted_count after cleanup", async () => {
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000);

    const file = join(tempDir, "app-2026-03-01T10.log");
    writeFileSync(file, "content");
    utimesSync(file, eightDaysAgo, eightDaysAgo);

    await cleanOldLogs(tempDir, now);

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "LOGS_CLEANUP_DONE",
        deleted_count: 1,
      })
    );
  });
});
