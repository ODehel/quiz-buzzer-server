import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openDatabase } from "../src/database/database.js";
import {
  createSound,
  getSound,
  listSounds,
  deleteSoundById,
  validateUuid,
  normalizeName,
} from "../src/services/soundService.js";

describe("soundService", () => {
  let db;
  let uploadsDir;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-sounds-"));
  });

  afterEach(async () => {
    db.close();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  const makeFile = (mimetype = "audio/mpeg", size = 1024) => ({
    buffer: Buffer.alloc(size, 0),
    mimetype,
    size,
  });

  // ── normalizeName ──────────────────────────────────────────────────────

  describe("normalizeName", () => {
    test("CA-3 — trims and collapses spaces", () => {
      expect(normalizeName("  Générique   intro  ")).toBe("Générique intro");
    });

    test("returns single word untouched", () => {
      expect(normalizeName("Jingle")).toBe("Jingle");
    });
  });

  // ── validateUuid ───────────────────────────────────────────────────────

  describe("validateUuid", () => {
    test("CA-17 — valid UUID passes", () => {
      expect(() => validateUuid("018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a")).not.toThrow();
    });

    test("CA-17 — invalid UUID throws INVALID_UUID", () => {
      expect(() => validateUuid("not-a-uuid")).toThrow(expect.objectContaining({ error: "INVALID_UUID" }));
    });

    test("CA-20 — invalid UUID throws INVALID_UUID", () => {
      expect(() => validateUuid("abc")).toThrow(expect.objectContaining({ error: "INVALID_UUID" }));
    });
  });

  // ── createSound ────────────────────────────────────────────────────────

  describe("createSound", () => {
    test("CA-1 — creates sound with valid mp3 file", async () => {
      const result = await createSound(db, "Générique intro", makeFile("audio/mpeg"), uploadsDir);

      expect(result).toMatchObject({
        name: "Générique intro",
        filename: expect.stringMatching(/\.mp3$/),
        url: expect.stringMatching(/^\/uploads\/sounds\/.+\.mp3$/),
        created_at: expect.any(String),
      });
      expect(result.id).toBeDefined();
    });

    test("CA-1 — creates sound with wav file", async () => {
      const result = await createSound(db, "Effect", makeFile("audio/wav"), uploadsDir);
      expect(result.filename).toMatch(/\.wav$/);
    });

    test("CA-1 — creates sound with ogg file", async () => {
      const result = await createSound(db, "Effect ogg", makeFile("audio/ogg"), uploadsDir);
      expect(result.filename).toMatch(/\.ogg$/);
    });

    test("CA-2 — file is saved as <uuid>.<ext> on disk", async () => {
      const result = await createSound(db, "Mon jingle", makeFile(), uploadsDir);
      const filePath = path.join(uploadsDir, "sounds", result.filename);
      const stat = await fs.stat(filePath);
      expect(stat.isFile()).toBe(true);
    });

    test("CA-3 — name is normalized before storage", async () => {
      const result = await createSound(db, "  Générique   intro  ", makeFile(), uploadsDir);
      expect(result.name).toBe("Générique intro");
    });

    test("CA-4 — empty name after normalization throws VALIDATION_ERROR", async () => {
      await expect(createSound(db, "   ", makeFile(), uploadsDir))
        .rejects.toThrow(expect.objectContaining({ error: "VALIDATION_ERROR" }));
    });

    test("CA-4 — name exceeding 100 chars throws VALIDATION_ERROR", async () => {
      const longName = "A".repeat(101);
      await expect(createSound(db, longName, makeFile(), uploadsDir))
        .rejects.toThrow(expect.objectContaining({ error: "VALIDATION_ERROR" }));
    });

    test("CA-4 — name of exactly 100 chars is accepted", async () => {
      const name = "A".repeat(100);
      const result = await createSound(db, name, makeFile(), uploadsDir);
      expect(result.name).toBe(name);
    });

    test("CA-9 — duplicate name (case-insensitive) throws SOUND_ALREADY_EXISTS", async () => {
      await createSound(db, "Générique", makeFile(), uploadsDir);
      await expect(createSound(db, "générique", makeFile(), uploadsDir))
        .rejects.toThrow(expect.objectContaining({ error: "SOUND_ALREADY_EXISTS", status: 409 }));
    });
  });

  // ── getSound ───────────────────────────────────────────────────────────

  describe("getSound", () => {
    test("CA-15 — returns sound by ID", async () => {
      const created = await createSound(db, "Test sound", makeFile(), uploadsDir);
      const result = getSound(db, created.id);
      expect(result).toMatchObject({
        id: created.id,
        name: "Test sound",
        filename: created.filename,
        url: created.url,
      });
    });

    test("CA-16 — non-existent ID throws NOT_FOUND", () => {
      expect(() => getSound(db, "018e4f5a-0000-0000-0000-000000000000"))
        .toThrow(expect.objectContaining({ error: "NOT_FOUND", status: 404 }));
    });

    test("CA-17 — malformed ID throws INVALID_UUID", () => {
      expect(() => getSound(db, "bad-id"))
        .toThrow(expect.objectContaining({ error: "INVALID_UUID", status: 400 }));
    });
  });

  // ── listSounds ─────────────────────────────────────────────────────────

  describe("listSounds", () => {
    test("CA-14 — returns empty list when no sounds", () => {
      const result = listSounds(db, 1, 20);
      expect(result).toEqual({
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        total_pages: 0,
      });
    });

    test("CA-11 — returns paginated list", async () => {
      await createSound(db, "Sound A", makeFile(), uploadsDir);
      await createSound(db, "Sound B", makeFile(), uploadsDir);
      await createSound(db, "Sound C", makeFile(), uploadsDir);

      const result = listSounds(db, 1, 2);
      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(3);
      expect(result.total_pages).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(2);
    });

    test("CA-12 — default pagination (page=1, limit=20)", async () => {
      await createSound(db, "Sound A", makeFile(), uploadsDir);
      const result = listSounds(db, 1, 20);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.data).toHaveLength(1);
    });

    test("CA-11 — each item has correct fields", async () => {
      await createSound(db, "My Jingle", makeFile(), uploadsDir);
      const result = listSounds(db, 1, 20);
      const item = result.data[0];
      expect(item).toHaveProperty("id");
      expect(item).toHaveProperty("name", "My Jingle");
      expect(item).toHaveProperty("filename");
      expect(item).toHaveProperty("url");
      expect(item).toHaveProperty("created_at");
    });
  });

  // ── deleteSoundById ────────────────────────────────────────────────────

  describe("deleteSoundById", () => {
    test("CA-18 — deletes sound and physical file", async () => {
      const created = await createSound(db, "To delete", makeFile(), uploadsDir);
      const filePath = path.join(uploadsDir, "sounds", created.filename);

      // Verify file exists
      await expect(fs.stat(filePath)).resolves.toBeDefined();

      await deleteSoundById(db, created.id, uploadsDir);

      // Verify DB deletion
      expect(() => getSound(db, created.id))
        .toThrow(expect.objectContaining({ error: "NOT_FOUND" }));

      // Verify file deletion
      await expect(fs.stat(filePath)).rejects.toThrow();
    });

    test("CA-19 — non-existent ID throws NOT_FOUND", async () => {
      await expect(deleteSoundById(db, "018e4f5a-0000-0000-0000-000000000000", uploadsDir))
        .rejects.toThrow(expect.objectContaining({ error: "NOT_FOUND", status: 404 }));
    });

    test("CA-20 — malformed ID throws INVALID_UUID", async () => {
      await expect(deleteSoundById(db, "bad", uploadsDir))
        .rejects.toThrow(expect.objectContaining({ error: "INVALID_UUID", status: 400 }));
    });

    test("CA-21 — file missing on disk still deletes DB entry, logs WARN", async () => {
      const created = await createSound(db, "Missing file", makeFile(), uploadsDir);
      // Manually delete the file
      await fs.unlink(path.join(uploadsDir, "sounds", created.filename));

      // Should not throw - tolerant to missing file
      await expect(deleteSoundById(db, created.id, uploadsDir)).resolves.not.toThrow();

      // DB entry should be gone
      expect(() => getSound(db, created.id))
        .toThrow(expect.objectContaining({ error: "NOT_FOUND" }));
    });
  });
});
