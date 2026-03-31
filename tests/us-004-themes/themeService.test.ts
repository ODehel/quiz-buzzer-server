import { openDatabase } from "../../src/database/database.ts";
import {
  createTheme,
  getTheme,
  listThemes,
  updateThemeById,
  deleteThemeById,
  normalizeName,
  validateUuid,
} from "../../src/services/themeService.ts";

let db;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("normalizeName", () => {
  test("trims and collapses spaces", () => {
    expect(normalizeName("  Science   fiction  ")).toBe("Science fiction");
  });
});

describe("validateUuid", () => {
  test("accepts valid UUID", () => {
    expect(() => validateUuid("018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a")).not.toThrow();
  });
  test("rejects invalid UUID", () => {
    expect(() => validateUuid("not-a-uuid")).toThrow();
  });
});

describe("createTheme", () => {
  test("CA-1: creates a theme with valid name", () => {
    const theme = createTheme(db, "Musique");
    expect(theme).toMatchObject({
      name: "Musique",
      last_updated_at: null,
    });
    expect(theme.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(theme.created_at).toBeDefined();
  });

  test("CA-2: normalizes name", () => {
    const theme = createTheme(db, "  Science   fiction  ");
    expect(theme.name).toBe("Science fiction");
  });

  test("CA-3: rejects name not matching regex", () => {
    expect(() => createTheme(db, "ab")).toThrow(); // too short
    expect(() => createTheme(db, "musique")).toThrow(); // lowercase start
    expect(() => createTheme(db, "M-")).toThrow(); // ends with dash
  });

  test("CA-3: rejects name longer than 40 characters", () => {
    const longName = "Abcdefghijklmnopqrstuvwxyzabcdefghijklmnop"; // 42 chars
    expect(() => createTheme(db, longName)).toThrow();
  });

  test("CA-4: rejects duplicate name case insensitive", () => {
    createTheme(db, "Musique");
    expect(() => createTheme(db, "MUSIQUE")).toThrow();
  });
});

describe("getTheme", () => {
  test("CA-9: returns theme by ID", () => {
    const created = createTheme(db, "Sport");
    const fetched = getTheme(db, created.id);
    expect(fetched).toEqual(created);
  });

  test("CA-10: throws 404 for non-existent ID", () => {
    expect(() => getTheme(db, "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a")).toThrow();
  });

  test("CA-11: throws 400 for invalid UUID", () => {
    expect(() => getTheme(db, "invalid")).toThrow();
  });
});

describe("listThemes", () => {
  test("CA-19: returns empty list when no themes", () => {
    const result = listThemes(db, 1, 20);
    expect(result).toEqual({
      data: [], page: 1, limit: 20, total: 0, total_pages: 0,
    });
  });

  test("CA-13: returns paginated list", () => {
    createTheme(db, "Musique");
    createTheme(db, "Sport");
    const result = listThemes(db, 1, 20);
    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.total_pages).toBe(1);
  });

  test("CA-14: sorts by created_at descending", () => {
    createTheme(db, "Alpha");
    createTheme(db, "Bravo");
    const result = listThemes(db, 1, 20);
    // Most recent first
    expect(result.data[0].name).toBe("Bravo");
  });

  test("CA-18: returns empty data for page beyond total", () => {
    createTheme(db, "Musique");
    const result = listThemes(db, 100, 20);
    expect(result.data).toEqual([]);
    expect(result.total).toBe(1);
  });
});

describe("updateThemeById", () => {
  test("CA-20: updates theme name", () => {
    const created = createTheme(db, "Musique");
    const updated = updateThemeById(db, created.id, "Histoire");
    expect(updated.name).toBe("Histoire");
    expect(updated.last_updated_at).not.toBeNull();
  });

  test("CA-22: unchanged name does not update timestamp", () => {
    const created = createTheme(db, "Musique");
    const result = updateThemeById(db, created.id, "musique");
    expect(result.last_updated_at).toBeNull();
  });

  test("CA-24: rejects duplicate name by another theme", () => {
    createTheme(db, "Musique");
    const sport = createTheme(db, "Sport");
    expect(() => updateThemeById(db, sport.id, "Musique")).toThrow();
  });

  test("CA-25: throws 404 for non-existent ID", () => {
    expect(() => updateThemeById(db, "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a", "Test")).toThrow();
  });
});

describe("deleteThemeById", () => {
  test("CA-28: deletes an existing theme", () => {
    const created = createTheme(db, "Musique");
    expect(() => deleteThemeById(db, created.id)).not.toThrow();
    expect(() => getTheme(db, created.id)).toThrow(); // 404
  });

  test("CA-29: throws 404 for non-existent ID", () => {
    expect(() => deleteThemeById(db, "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a")).toThrow();
  });
});