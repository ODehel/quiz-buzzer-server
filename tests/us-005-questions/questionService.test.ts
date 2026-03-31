import { openDatabase } from "../../src/database/database.ts";
import {
  createQuestion,
  getQuestion,
  listQuestions,
  updateQuestionById,
  patchQuestionById,
  deleteQuestionById,
  normalizeTitle,
  validateUuid,
  parsePagination,
  parseFilters,
} from "../../src/services/questionService.ts";
import { AppError } from "../../src/errors/AppError.ts";

let db;
let themeId;

beforeEach(() => {
  db = openDatabase(":memory:");
  // Insert a theme for FK references
  db.prepare(
    "INSERT INTO T_THEME_THM (THM_ID, THM_NAME, THM_CREATED_AT) VALUES (?, ?, ?)"
  ).run("018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a", "Science", "2026-03-09T10:00:00.000Z");
  themeId = "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a";
});

afterEach(() => {
  db.close();
});

// ─── normalizeTitle ───────────────────────────────────────────────────────────

describe("normalizeTitle", () => {
  test("trims whitespace", () => {
    expect(normalizeTitle("  Hello world  ")).toBe("Hello world");
  });
  test("collapses multiple spaces", () => {
    expect(normalizeTitle("Hello   world")).toBe("Hello world");
  });
});

// ─── validateUuid ─────────────────────────────────────────────────────────────

describe("validateUuid", () => {
  test("accepts valid UUID", () => {
    expect(() => validateUuid("018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a")).not.toThrow();
  });
  test("rejects invalid UUID", () => {
    expect(() => validateUuid("not-a-uuid")).toThrow(AppError);
  });
});

// ─── parsePagination ─────────────────────────────────────────────────────────

describe("parsePagination", () => {
  test("defaults page=1 limit=20", () => {
    const url = new URL("http://localhost/api/v1/questions");
    expect(parsePagination(url)).toEqual({ page: 1, limit: 20 });
  });
  test("parses page and limit", () => {
    const url = new URL("http://localhost/api/v1/questions?page=2&limit=10");
    expect(parsePagination(url)).toEqual({ page: 2, limit: 10 });
  });
  test("throws for limit > 100", () => {
    const url = new URL("http://localhost/api/v1/questions?limit=200");
    expect(() => parsePagination(url)).toThrow(AppError);
  });
  test("throws for negative page", () => {
    const url = new URL("http://localhost/api/v1/questions?page=-1");
    expect(() => parsePagination(url)).toThrow(AppError);
  });
});

// ─── parseFilters ─────────────────────────────────────────────────────────────

describe("parseFilters", () => {
  test("accepts empty filters", () => {
    const url = new URL("http://localhost/api/v1/questions");
    expect(parseFilters(url, db)).toEqual({});
  });
  test("accepts valid type filter", () => {
    const url = new URL("http://localhost/api/v1/questions?type=MCQ");
    const filters = parseFilters(url, db);
    expect(filters.type).toBe("MCQ");
  });
  test("throws for invalid type", () => {
    const url = new URL("http://localhost/api/v1/questions?type=INVALID");
    expect(() => parseFilters(url, db)).toThrow(AppError);
  });
  test("accepts valid theme_id", () => {
    const url = new URL(`http://localhost/api/v1/questions?theme_id=${themeId}`);
    const filters = parseFilters(url, db);
    expect(filters.theme_id).toBe(themeId);
  });
  test("throws for non-existent theme_id", () => {
    const url = new URL("http://localhost/api/v1/questions?theme_id=018e4f5a-0000-0000-0000-000000000000");
    expect(() => parseFilters(url, db)).toThrow(AppError);
  });
  test("throws for invalid UUID theme_id", () => {
    const url = new URL("http://localhost/api/v1/questions?theme_id=not-a-uuid");
    expect(() => parseFilters(url, db)).toThrow(AppError);
  });
  test("throws when level and level_min both present", () => {
    const url = new URL("http://localhost/api/v1/questions?level=3&level_min=2");
    expect(() => parseFilters(url, db)).toThrow(AppError);
  });
  test("throws for level_min > level_max", () => {
    const url = new URL("http://localhost/api/v1/questions?level_min=4&level_max=2");
    expect(() => parseFilters(url, db)).toThrow(AppError);
  });
  test("throws for invalid numeric filter value", () => {
    const url = new URL("http://localhost/api/v1/questions?level=abc");
    expect(() => parseFilters(url, db)).toThrow(AppError);
  });
  test("throws for points_min > points_max", () => {
    const url = new URL("http://localhost/api/v1/questions?points_min=30&points_max=10");
    expect(() => parseFilters(url, db)).toThrow(AppError);
  });
  test("ignores unknown query params", () => {
    const url = new URL("http://localhost/api/v1/questions?foo=bar");
    expect(() => parseFilters(url, db)).not.toThrow();
  });
});

// ─── createQuestion ────────────────────────────────────────────────────────────

describe("createQuestion", () => {
  const validMcq = {
    type: "MCQ", theme_id: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a",
    title: "Quelle est la capitale de la France ?",
    choices: ["Paris", "Lyon", "Marseille", "Toulouse"],
    correct_answer: "Paris", level: 1, time_limit: 30, points: 10,
  };
  const validSpeed = {
    type: "SPEED", theme_id: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a",
    title: "Quel est le plus grand océan du monde ?",
    correct_answer: "Pacifique", level: 2, time_limit: 15, points: 20,
  };

  test("creates MCQ question successfully", () => {
    const q = createQuestion(db, validMcq);
    expect(q.type).toBe("MCQ");
    expect(q.choices).toHaveLength(4);
    expect(q.last_updated_at).toBeNull();
    expect(q.image_path).toBeNull();
    expect(q.audio_path).toBeNull();
  });

  test("creates SPEED question without choices field", () => {
    const q = createQuestion(db, validSpeed);
    expect(q.type).toBe("SPEED");
    expect(q).not.toHaveProperty("choices");
    expect(q.correct_answer).toBe("Pacifique");
  });

  test("normalizes title whitespace", () => {
    const q = createQuestion(db, { ...validMcq, title: "  Quelle est   la capitale ?  " });
    expect(q.title).toBe("Quelle est la capitale ?");
  });

  test("409 - duplicate title (case-insensitive)", () => {
    createQuestion(db, validMcq);
    expect(() => createQuestion(db, { ...validMcq, title: validMcq.title.toUpperCase() }))
      .toThrow(AppError);
  });

  test("400 - invalid type", () => {
    expect(() => createQuestion(db, { ...validMcq, type: "INVALID" })).toThrow(AppError);
  });

  test("400 - missing type", () => {
    const { type, ...rest } = validMcq;
    expect(() => createQuestion(db, rest)).toThrow(AppError);
  });

  test("400 - SPEED with choices", () => {
    const err = (() => {
      try { createQuestion(db, { ...validSpeed, choices: ["A", "B", "C", "D"] }); }
      catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect(err.error).toBe("VALIDATION_ERROR");
  });

  test("400 - MCQ without choices", () => {
    const { choices, ...rest } = validMcq;
    expect(() => createQuestion(db, rest)).toThrow(AppError);
  });

  test("400 - MCQ with wrong number of choices", () => {
    expect(() => createQuestion(db, { ...validMcq, choices: ["A", "B", "C"] })).toThrow(AppError);
  });

  test("400 - MCQ with duplicate choices", () => {
    expect(() => createQuestion(db, { ...validMcq, choices: ["Paris", "paris", "Marseille", "Toulouse"] })).toThrow(AppError);
  });

  test("400 - MCQ correct_answer not in choices", () => {
    expect(() => createQuestion(db, { ...validMcq, correct_answer: "Nice" })).toThrow(AppError);
  });

  test("400 - MCQ correct_answer matches choice case-insensitively", () => {
    const q = createQuestion(db, { ...validMcq, correct_answer: "paris" });
    expect(q.correct_answer).toBe("paris");
  });

  test("400 - invalid theme_id UUID", () => {
    const err = (() => {
      try { createQuestion(db, { ...validMcq, theme_id: "not-a-uuid" }); }
      catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect(err.error).toBe("INVALID_UUID");
  });

  test("400 - theme_id does not exist", () => {
    const err = (() => {
      try { createQuestion(db, { ...validMcq, theme_id: "018e4f5a-0000-0000-0000-000000000000" }); }
      catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect(err.error).toBe("INVALID_THEME");
  });

  test("400 - level out of range", () => {
    expect(() => createQuestion(db, { ...validMcq, level: 6 })).toThrow(AppError);
  });

  test("400 - time_limit out of range", () => {
    expect(() => createQuestion(db, { ...validMcq, time_limit: 3 })).toThrow(AppError);
  });

  test("400 - points out of range", () => {
    expect(() => createQuestion(db, { ...validMcq, points: 51 })).toThrow(AppError);
  });

  test("400 - unknown field", () => {
    const err = (() => {
      try { createQuestion(db, { ...validMcq, image_path: "/img.jpg" }); }
      catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect(err.error).toBe("UNKNOWN_FIELDS");
  });

  test("400 - title too short", () => {
    expect(() => createQuestion(db, { ...validMcq, title: "Court" })).toThrow(AppError);
  });

  test("400 - title not starting with uppercase", () => {
    expect(() => createQuestion(db, { ...validMcq, title: "quelle est la capitale de la France ?" })).toThrow(AppError);
  });
});

// ─── getQuestion ───────────────────────────────────────────────────────────────

describe("getQuestion", () => {
  test("returns question by ID", () => {
    const created = createQuestion(db, {
      type: "MCQ", theme_id: themeId,
      title: "Quelle est la capitale de la France ?",
      choices: ["Paris", "Lyon", "Marseille", "Toulouse"],
      correct_answer: "Paris", level: 1, time_limit: 30, points: 10,
    });
    const q = getQuestion(db, created.id);
    expect(q.id).toBe(created.id);
  });

  test("404 - not found", () => {
    expect(() => getQuestion(db, "018e4f5a-0000-0000-0000-000000000000")).toThrow(AppError);
  });

  test("400 - invalid UUID", () => {
    expect(() => getQuestion(db, "bad")).toThrow(AppError);
  });
});

// ─── listQuestions ─────────────────────────────────────────────────────────────

describe("listQuestions", () => {
  test("returns empty list", () => {
    const result = listQuestions(db, {}, 1, 20);
    expect(result).toMatchObject({ data: [], page: 1, limit: 20, total: 0, total_pages: 0 });
  });

  test("paginates correctly", () => {
    for (let i = 1; i <= 3; i++) {
      createQuestion(db, {
        type: "SPEED", theme_id: themeId,
        title: `Question numéro ${String(i).padStart(2, "0")} pour le test`,
        correct_answer: "Réponse", level: 1, time_limit: 10, points: 5,
      });
    }
    const result = listQuestions(db, {}, 1, 2);
    expect(result.total).toBe(3);
    expect(result.data).toHaveLength(2);
    expect(result.total_pages).toBe(2);
  });

  test("filters by type", () => {
    createQuestion(db, {
      type: "MCQ", theme_id: themeId,
      title: "Quelle est la capitale de la France ?",
      choices: ["Paris", "Lyon", "Marseille", "Toulouse"],
      correct_answer: "Paris", level: 1, time_limit: 30, points: 10,
    });
    createQuestion(db, {
      type: "SPEED", theme_id: themeId,
      title: "Quel est le plus grand océan du monde ?",
      correct_answer: "Pacifique", level: 2, time_limit: 15, points: 20,
    });
    const result = listQuestions(db, { type: "MCQ" }, 1, 20);
    expect(result.total).toBe(1);
    expect(result.data[0].type).toBe("MCQ");
  });
});

// ─── updateQuestionById (PUT) ─────────────────────────────────────────────────

describe("updateQuestionById", () => {
  let questionId;

  beforeEach(() => {
    const q = createQuestion(db, {
      type: "MCQ", theme_id: themeId,
      title: "Quelle est la capitale de la France ?",
      choices: ["Paris", "Lyon", "Marseille", "Toulouse"],
      correct_answer: "Paris", level: 1, time_limit: 30, points: 10,
    });
    questionId = q.id;
  });

  test("updates question and sets last_updated_at", () => {
    const updated = updateQuestionById(db, questionId, {
      type: "MCQ", theme_id: themeId,
      title: "Quelle est la capitale de l'Allemagne ?",
      choices: ["Berlin", "Munich", "Hambourg", "Cologne"],
      correct_answer: "Berlin", level: 2, time_limit: 20, points: 15,
    });
    expect(updated.title).toBe("Quelle est la capitale de l'Allemagne ?");
    expect(updated.last_updated_at).not.toBeNull();
  });

  test("CA-49 - identical data does not update last_updated_at", () => {
    const updated = updateQuestionById(db, questionId, {
      type: "MCQ", theme_id: themeId,
      title: "Quelle est la capitale de la France ?",
      choices: ["Paris", "Lyon", "Marseille", "Toulouse"],
      correct_answer: "Paris", level: 1, time_limit: 30, points: 10,
    });
    expect(updated.last_updated_at).toBeNull();
  });

  test("CA-48 - type change rejected", () => {
    const err = (() => {
      try {
        updateQuestionById(db, questionId, {
          type: "SPEED", theme_id: themeId,
          title: "Quelle est la capitale de l'Espagne ?",
          correct_answer: "Madrid", level: 1, time_limit: 30, points: 10,
        });
      } catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect(err.error).toBe("TYPE_CHANGE_NOT_ALLOWED");
  });

  test("CA-50 - ID mismatch in body", () => {
    const err = (() => {
      try {
        updateQuestionById(db, questionId, {
          id: "018e4f5a-0000-0000-0000-000000000000",
          type: "MCQ", theme_id: themeId,
          title: "Quelle est la capitale de l'Espagne ?",
          choices: ["Madrid", "Barcelone", "Séville", "Valence"],
          correct_answer: "Madrid", level: 1, time_limit: 30, points: 10,
        });
      } catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect(err.error).toBe("ID_MISMATCH");
  });

  test("404 - question not found", () => {
    expect(() => updateQuestionById(db, "018e4f5a-0000-0000-0000-000000000000", {
      type: "MCQ", theme_id: themeId,
      title: "Une autre question de test ici",
      choices: ["A", "B", "C", "D"],
      correct_answer: "A", level: 1, time_limit: 30, points: 10,
    })).toThrow(AppError);
  });

  test("409 - title conflict with another question", () => {
    createQuestion(db, {
      type: "SPEED", theme_id: themeId,
      title: "Quel est le plus grand océan du monde ?",
      correct_answer: "Pacifique", level: 2, time_limit: 15, points: 20,
    });
    const err = (() => {
      try {
        updateQuestionById(db, questionId, {
          type: "MCQ", theme_id: themeId,
          title: "Quel est le plus grand océan du monde ?",
          choices: ["Pacifique", "Atlantique", "Indien", "Arctique"],
          correct_answer: "Pacifique", level: 1, time_limit: 30, points: 10,
        });
      } catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect(err.error).toBe("QUESTION_ALREADY_EXISTS");
  });
});

// ─── patchQuestionById ─────────────────────────────────────────────────────────

describe("patchQuestionById", () => {
  let questionId;

  beforeEach(() => {
    const q = createQuestion(db, {
      type: "MCQ", theme_id: themeId,
      title: "Quelle est la capitale de la France ?",
      choices: ["Paris", "Lyon", "Marseille", "Toulouse"],
      correct_answer: "Paris", level: 1, time_limit: 30, points: 10,
    });
    questionId = q.id;
  });

  test("patches a single field", () => {
    const updated = patchQuestionById(db, questionId, { level: 3 });
    expect(updated.level).toBe(3);
    expect(updated.last_updated_at).not.toBeNull();
  });

  test("CA-73 - empty body returns unchanged question", () => {
    const updated = patchQuestionById(db, questionId, {});
    expect(updated.last_updated_at).toBeNull();
  });

  test("CA-70 - identical data does not update last_updated_at", () => {
    const updated = patchQuestionById(db, questionId, { level: 1 });
    expect(updated.last_updated_at).toBeNull();
  });

  test("CA-60 - type change rejected", () => {
    const err = (() => {
      try { patchQuestionById(db, questionId, { type: "SPEED" }); }
      catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect(err.error).toBe("TYPE_CHANGE_NOT_ALLOWED");
  });

  test("CA-61 - id in body rejected", () => {
    const err = (() => {
      try { patchQuestionById(db, questionId, { id: questionId }); }
      catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect(err.error).toBe("UNKNOWN_FIELDS");
  });

  test("CA-58 - null for required field rejected", () => {
    expect(() => patchQuestionById(db, questionId, { level: null })).toThrow(AppError);
  });

  test("CA-59 - null choices on MCQ rejected", () => {
    expect(() => patchQuestionById(db, questionId, { choices: null })).toThrow(AppError);
  });

  test("CA-65b - choices on SPEED rejected", () => {
    const speedQ = createQuestion(db, {
      type: "SPEED", theme_id: themeId,
      title: "Quel est le plus grand océan du monde ?",
      correct_answer: "Pacifique", level: 2, time_limit: 15, points: 20,
    });
    const err = (() => {
      try { patchQuestionById(db, speedQ.id, { choices: ["A", "B", "C", "D"] }); }
      catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect(err.error).toBe("VALIDATION_ERROR");
  });

  test("CA-66 - correct_answer validated against merged choices", () => {
    const updated = patchQuestionById(db, questionId, {
      choices: ["Berlin", "Munich", "Hambourg", "Cologne"],
      correct_answer: "Berlin",
    });
    expect(updated.correct_answer).toBe("Berlin");
  });

  test("patches image_path", () => {
    const updated = patchQuestionById(db, questionId, { image_path: "/img/flag.jpg" });
    expect(updated.image_path).toBe("/img/flag.jpg");
  });

  test("CA-68 - empty image_path rejected", () => {
    expect(() => patchQuestionById(db, questionId, { image_path: "" })).toThrow(AppError);
  });

  test("sets image_path to null", () => {
    patchQuestionById(db, questionId, { image_path: "/img/flag.jpg" });
    const updated = patchQuestionById(db, questionId, { image_path: null });
    expect(updated.image_path).toBeNull();
  });

  test("404 - question not found", () => {
    expect(() => patchQuestionById(db, "018e4f5a-0000-0000-0000-000000000000", { level: 2 })).toThrow(AppError);
  });
});

// ─── deleteQuestionById ────────────────────────────────────────────────────────

describe("deleteQuestionById", () => {
  test("deletes existing question", () => {
    const q = createQuestion(db, {
      type: "SPEED", theme_id: themeId,
      title: "Quel est le plus grand océan du monde ?",
      correct_answer: "Pacifique", level: 2, time_limit: 15, points: 20,
    });
    expect(() => deleteQuestionById(db, q.id)).not.toThrow();
    expect(() => getQuestion(db, q.id)).toThrow(AppError);
  });

  test("404 - question not found", () => {
    expect(() => deleteQuestionById(db, "018e4f5a-0000-0000-0000-000000000000")).toThrow(AppError);
  });

  test("400 - invalid UUID", () => {
    expect(() => deleteQuestionById(db, "bad")).toThrow(AppError);
  });
});

// ─── Additional coverage tests ────────────────────────────────────────────────

describe("validateTitle edge cases", () => {
  test("title empty string (trimmed)", () => {
    expect(() => createQuestion(db, {
      type: "MCQ", theme_id: themeId,
      title: "         ", // becomes empty after normalization
      choices: ["A", "B", "C", "D"], correct_answer: "A", level: 1, time_limit: 30, points: 10,
    })).toThrow(AppError);
  });

  test("title > 250 chars", () => {
    expect(() => createQuestion(db, {
      type: "MCQ", theme_id: themeId,
      title: "Q".repeat(251),
      choices: ["A", "B", "C", "D"], correct_answer: "A", level: 1, time_limit: 30, points: 10,
    })).toThrow(AppError);
  });
});

describe("validateChoices edge cases", () => {
  test("choice is not a string", () => {
    expect(() => createQuestion(db, {
      type: "MCQ", theme_id: themeId,
      title: "Quelle est la capitale de la France ?",
      choices: ["Paris", 42, "Marseille", "Toulouse"],
      correct_answer: "Paris", level: 1, time_limit: 30, points: 10,
    })).toThrow(AppError);
  });

  test("choice too long (> 100 chars)", () => {
    expect(() => createQuestion(db, {
      type: "MCQ", theme_id: themeId,
      title: "Quelle est la capitale de la France ?",
      choices: ["Paris", "L".repeat(101), "Marseille", "Toulouse"],
      correct_answer: "Paris", level: 1, time_limit: 30, points: 10,
    })).toThrow(AppError);
  });

  test("choice of exactly 100 chars is valid", () => {
    expect(() => createQuestion(db, {
      type: "MCQ", theme_id: themeId,
      title: "Quelle est la capitale de la France ?",
      choices: ["Paris", "L".repeat(100), "Marseille", "Toulouse"],
      correct_answer: "Paris", level: 1, time_limit: 30, points: 10,
    })).not.toThrow();
  });
});

describe("validateCorrectAnswer edge cases", () => {
  test("correct_answer not a string (number)", () => {
    expect(() => createQuestion(db, {
      type: "MCQ", theme_id: themeId,
      title: "Quelle est la capitale de la France ?",
      choices: ["Paris", "Lyon", "Marseille", "Toulouse"],
      correct_answer: 42, level: 1, time_limit: 30, points: 10,
    })).toThrow(AppError);
  });

  test("correct_answer empty string", () => {
    expect(() => createQuestion(db, {
      type: "SPEED", theme_id: themeId,
      title: "Quel est le plus grand océan du monde ?",
      correct_answer: "   ", level: 2, time_limit: 15, points: 20,
    })).toThrow(AppError);
  });

  test("correct_answer too long (> 100 chars) for SPEED", () => {
    expect(() => createQuestion(db, {
      type: "SPEED", theme_id: themeId,
      title: "Quel est le plus grand océan du monde ?",
      correct_answer: "R".repeat(101), level: 2, time_limit: 15, points: 20,
    })).toThrow(AppError);
  });

  test("correct_answer of exactly 100 chars is valid for SPEED", () => {
    expect(() => createQuestion(db, {
      type: "SPEED", theme_id: themeId,
      title: "Quel est le plus grand océan du monde ?",
      correct_answer: "R".repeat(100), level: 2, time_limit: 15, points: 20,
    })).not.toThrow();
  });
});

describe("parseFilters additional coverage", () => {
  test("invalid level_min (out of range)", () => {
    const url = new URL("http://localhost/api/v1/questions?level_min=6");
    expect(() => parseFilters(url, db)).toThrow(AppError);
  });

  test("invalid level_max (out of range)", () => {
    const url = new URL("http://localhost/api/v1/questions?level_max=0");
    expect(() => parseFilters(url, db)).toThrow(AppError);
  });

  test("invalid time_limit_min", () => {
    const url = new URL("http://localhost/api/v1/questions?time_limit_min=abc");
    expect(() => parseFilters(url, db)).toThrow(AppError);
  });

  test("invalid time_limit_max", () => {
    const url = new URL("http://localhost/api/v1/questions?time_limit_max=100");
    expect(() => parseFilters(url, db)).toThrow(AppError);
  });

  test("time_limit_min > time_limit_max", () => {
    const url = new URL("http://localhost/api/v1/questions?time_limit_min=30&time_limit_max=10");
    expect(() => parseFilters(url, db)).toThrow(AppError);
  });

  test("invalid points_min", () => {
    const url = new URL("http://localhost/api/v1/questions?points_min=abc");
    expect(() => parseFilters(url, db)).toThrow(AppError);
  });

  test("invalid points_max (out of range)", () => {
    const url = new URL("http://localhost/api/v1/questions?points_max=60");
    expect(() => parseFilters(url, db)).toThrow(AppError);
  });
});

describe("createQuestion additional required fields", () => {
  const base = {
    type: "MCQ", theme_id: "018e4f5a-8c3b-7d2e-9f1a-4b5c6d7e8f9a",
    title: "Quelle est la capitale de la France ?",
    choices: ["Paris", "Lyon", "Marseille", "Toulouse"],
    correct_answer: "Paris", level: 1, time_limit: 30, points: 10,
  };

  test("missing theme_id", () => {
    const { theme_id, ...rest } = base;
    expect(() => createQuestion(db, rest)).toThrow(AppError);
  });

  test("null theme_id", () => {
    expect(() => createQuestion(db, { ...base, theme_id: null })).toThrow(AppError);
  });

  test("null title", () => {
    expect(() => createQuestion(db, { ...base, title: null })).toThrow(AppError);
  });

  test("null correct_answer", () => {
    expect(() => createQuestion(db, { ...base, correct_answer: null })).toThrow(AppError);
  });

  test("null level", () => {
    expect(() => createQuestion(db, { ...base, level: null })).toThrow(AppError);
  });

  test("null time_limit", () => {
    expect(() => createQuestion(db, { ...base, time_limit: null })).toThrow(AppError);
  });

  test("null points", () => {
    expect(() => createQuestion(db, { ...base, points: null })).toThrow(AppError);
  });
});

describe("updateQuestionById additional coverage", () => {
  let questionId, speedQuestionId;

  beforeEach(() => {
    const q = createQuestion(db, {
      type: "MCQ", theme_id: themeId,
      title: "Quelle est la capitale de la France ?",
      choices: ["Paris", "Lyon", "Marseille", "Toulouse"],
      correct_answer: "Paris", level: 1, time_limit: 30, points: 10,
    });
    questionId = q.id;

    const sq = createQuestion(db, {
      type: "SPEED", theme_id: themeId,
      title: "Quel est le plus grand océan du monde ?",
      correct_answer: "Pacifique", level: 2, time_limit: 15, points: 20,
    });
    speedQuestionId = sq.id;
  });

  test("missing type", () => {
    const { type, ...rest } = {
      type: "MCQ", theme_id: themeId,
      title: "Quelle est la capitale de l'Allemagne ?",
      choices: ["Berlin", "Munich", "Hambourg", "Cologne"],
      correct_answer: "Berlin", level: 2, time_limit: 20, points: 15,
    };
    expect(() => updateQuestionById(db, questionId, rest)).toThrow(AppError);
  });

  test("SPEED with choices in PUT", () => {
    const err = (() => {
      try {
        updateQuestionById(db, speedQuestionId, {
          type: "SPEED", theme_id: themeId,
          title: "Quel est le plus grand océan du monde ?",
          choices: ["A", "B", "C", "D"],
          correct_answer: "Pacifique", level: 2, time_limit: 15, points: 20,
        });
      } catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect(err.error).toBe("VALIDATION_ERROR");
  });

  test("null theme_id in PUT", () => {
    expect(() => updateQuestionById(db, questionId, {
      type: "MCQ", theme_id: null,
      title: "Quelle est la capitale de l'Allemagne ?",
      choices: ["Berlin", "Munich", "Hambourg", "Cologne"],
      correct_answer: "Berlin", level: 2, time_limit: 20, points: 15,
    })).toThrow(AppError);
  });

  test("invalid theme_id UUID in PUT", () => {
    expect(() => updateQuestionById(db, questionId, {
      type: "MCQ", theme_id: "not-a-uuid",
      title: "Quelle est la capitale de l'Allemagne ?",
      choices: ["Berlin", "Munich", "Hambourg", "Cologne"],
      correct_answer: "Berlin", level: 2, time_limit: 20, points: 15,
    })).toThrow(AppError);
  });

  test("theme_id not found in PUT", () => {
    expect(() => updateQuestionById(db, questionId, {
      type: "MCQ", theme_id: "018e4f5a-0000-0000-0000-000000000000",
      title: "Quelle est la capitale de l'Allemagne ?",
      choices: ["Berlin", "Munich", "Hambourg", "Cologne"],
      correct_answer: "Berlin", level: 2, time_limit: 20, points: 15,
    })).toThrow(AppError);
  });

  test("null title in PUT", () => {
    expect(() => updateQuestionById(db, questionId, {
      type: "MCQ", theme_id: themeId, title: null,
      choices: ["Berlin", "Munich", "Hambourg", "Cologne"],
      correct_answer: "Berlin", level: 2, time_limit: 20, points: 15,
    })).toThrow(AppError);
  });

  test("MCQ without choices in PUT", () => {
    expect(() => updateQuestionById(db, questionId, {
      type: "MCQ", theme_id: themeId,
      title: "Quelle est la capitale de l'Allemagne ?",
      correct_answer: "Berlin", level: 2, time_limit: 20, points: 15,
    })).toThrow(AppError);
  });

  test("null correct_answer in PUT", () => {
    expect(() => updateQuestionById(db, questionId, {
      type: "MCQ", theme_id: themeId,
      title: "Quelle est la capitale de l'Allemagne ?",
      choices: ["Berlin", "Munich", "Hambourg", "Cologne"],
      correct_answer: null, level: 2, time_limit: 20, points: 15,
    })).toThrow(AppError);
  });

  test("null level in PUT", () => {
    expect(() => updateQuestionById(db, questionId, {
      type: "MCQ", theme_id: themeId,
      title: "Quelle est la capitale de l'Allemagne ?",
      choices: ["Berlin", "Munich", "Hambourg", "Cologne"],
      correct_answer: "Berlin", level: null, time_limit: 20, points: 15,
    })).toThrow(AppError);
  });

  test("null time_limit in PUT", () => {
    expect(() => updateQuestionById(db, questionId, {
      type: "MCQ", theme_id: themeId,
      title: "Quelle est la capitale de l'Allemagne ?",
      choices: ["Berlin", "Munich", "Hambourg", "Cologne"],
      correct_answer: "Berlin", level: 2, time_limit: null, points: 15,
    })).toThrow(AppError);
  });

  test("null points in PUT", () => {
    expect(() => updateQuestionById(db, questionId, {
      type: "MCQ", theme_id: themeId,
      title: "Quelle est la capitale de l'Allemagne ?",
      choices: ["Berlin", "Munich", "Hambourg", "Cologne"],
      correct_answer: "Berlin", level: 2, time_limit: 20, points: null,
    })).toThrow(AppError);
  });
});

describe("patchQuestionById additional coverage", () => {
  let questionId;

  beforeEach(() => {
    const q = createQuestion(db, {
      type: "MCQ", theme_id: themeId,
      title: "Quelle est la capitale de la France ?",
      choices: ["Paris", "Lyon", "Marseille", "Toulouse"],
      correct_answer: "Paris", level: 1, time_limit: 30, points: 10,
    });
    questionId = q.id;
  });

  test("non-object body", () => {
    expect(() => patchQuestionById(db, questionId, "not an object")).toThrow(AppError);
  });

  test("unknown field in PATCH", () => {
    expect(() => patchQuestionById(db, questionId, { foo: "bar" })).toThrow(AppError);
  });

  test("null theme_id in PATCH", () => {
    expect(() => patchQuestionById(db, questionId, { theme_id: null })).toThrow(AppError);
  });

  test("invalid theme_id UUID in PATCH", () => {
    expect(() => patchQuestionById(db, questionId, { theme_id: "not-a-uuid" })).toThrow(AppError);
  });

  test("non-existent theme_id in PATCH", () => {
    expect(() => patchQuestionById(db, questionId, { theme_id: "018e4f5a-0000-0000-0000-000000000000" })).toThrow(AppError);
  });

  test("null title in PATCH", () => {
    expect(() => patchQuestionById(db, questionId, { title: null })).toThrow(AppError);
  });

  test("title conflict in PATCH", () => {
    createQuestion(db, {
      type: "SPEED", theme_id: themeId,
      title: "Quel est le plus grand océan du monde ?",
      correct_answer: "Pacifique", level: 2, time_limit: 15, points: 20,
    });
    expect(() => patchQuestionById(db, questionId, {
      title: "Quel est le plus grand océan du monde ?",
    })).toThrow(AppError);
  });

  test("null correct_answer in PATCH", () => {
    expect(() => patchQuestionById(db, questionId, { correct_answer: null })).toThrow(AppError);
  });

  test("null time_limit in PATCH", () => {
    expect(() => patchQuestionById(db, questionId, { time_limit: null })).toThrow(AppError);
  });

  test("null points in PATCH", () => {
    expect(() => patchQuestionById(db, questionId, { points: null })).toThrow(AppError);
  });

  test("empty audio_path in PATCH", () => {
    expect(() => patchQuestionById(db, questionId, { audio_path: "" })).toThrow(AppError);
  });

  test("SPEED correct_answer patched without choices (SPEED has null choices)", () => {
    const speedQ = createQuestion(db, {
      type: "SPEED", theme_id: themeId,
      title: "Quel est le plus grand océan du monde ?",
      correct_answer: "Pacifique", level: 2, time_limit: 15, points: 20,
    });
    const updated = patchQuestionById(db, speedQ.id, { correct_answer: "Atlantique" });
    expect(updated.correct_answer).toBe("Atlantique");
  });
});
// ─── CA-46: PUT SPEED question successful update ───────────────────────────────

describe("CA-46: updateQuestionById — SPEED question", () => {
  let speedQuestionId;

  beforeEach(() => {
    const sq = createQuestion(db, {
      type: "SPEED", theme_id: themeId,
      title: "Quel est le plus grand océan du monde ?",
      correct_answer: "Pacifique", level: 2, time_limit: 15, points: 20,
    });
    speedQuestionId = sq.id;
  });

  // CA-46 : Modifier une question SPEED avec tous les champs valides
  test("CA-46: updates SPEED question and sets last_updated_at", () => {
    const updated = updateQuestionById(db, speedQuestionId, {
      type: "SPEED", theme_id: themeId,
      title: "Quelle est la plus grande planète du système solaire ?",
      correct_answer: "Jupiter", level: 3, time_limit: 20, points: 15,
    });
    expect(updated.type).toBe("SPEED");
    expect(updated.title).toBe("Quelle est la plus grande planète du système solaire ?");
    expect(updated.correct_answer).toBe("Jupiter");
    expect(updated.level).toBe(3);
    expect(updated.last_updated_at).not.toBeNull();
    expect(updated.choices).toBeUndefined();
  });
});

// ─── CA-62: PATCH theme_id to a valid existing theme ──────────────────────────

describe("CA-62: patchQuestionById — theme_id update", () => {
  let questionId;
  const secondThemeId = "018e4f5a-8c3b-7d2e-9f1a-000000000002";

  beforeEach(() => {
    db.prepare(
      "INSERT INTO T_THEME_THM (THM_ID, THM_NAME, THM_CREATED_AT) VALUES (?, ?, ?)"
    ).run(secondThemeId, "Sciences", "2026-03-09T11:00:00.000Z");

    const q = createQuestion(db, {
      type: "MCQ", theme_id: themeId,
      title: "Quelle est la capitale de la France ?",
      choices: ["Paris", "Lyon", "Marseille", "Toulouse"],
      correct_answer: "Paris", level: 1, time_limit: 30, points: 10,
    });
    questionId = q.id;
  });

  // CA-62 : Modification du theme_id vers un thème existant
  test("CA-62: patches theme_id to an existing theme", () => {
    const updated = patchQuestionById(db, questionId, { theme_id: secondThemeId });
    expect(updated.theme_id).toBe(secondThemeId);
    expect(updated.last_updated_at).not.toBeNull();
  });
});
