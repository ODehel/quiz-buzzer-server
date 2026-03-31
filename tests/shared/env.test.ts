import { loadEnv } from "../../src/config/env.ts";

describe("loadEnv", () => {
  it("should return config when JWT_SECRET is valid (≥ 32 chars)", () => {
    const source = {
      JWT_SECRET: "a-secret-that-is-definitely-at-least-32-characters-long",
      JWT_EXPIRATION: "7200",
      PORT: "4000",
    };

    const config = loadEnv(source);

    expect(config.jwtSecret).toBe(source.JWT_SECRET);
    expect(config.jwtExpiration).toBe(7200);
    expect(config.port).toBe(4000);
  });

  it("should use default values for JWT_EXPIRATION and PORT", () => {
    const source = {
      JWT_SECRET: "a-secret-that-is-definitely-at-least-32-characters-long",
    };

    const config = loadEnv(source);

    expect(config.jwtExpiration).toBe(3600);
    expect(config.port).toBe(3000);
  });

  it("should throw if JWT_SECRET is missing", () => {
    expect(() => loadEnv({})).toThrow("JWT_SECRET must be defined");
  });

  it("should throw if JWT_SECRET is too short", () => {
    expect(() => loadEnv({ JWT_SECRET: "short" })).toThrow("at least 32 characters");
  });
    it("should use process.env as default source", () => {
    const originalSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "a-secret-that-is-definitely-at-least-32-characters-long";

    try {
      // Appel sans argument → utilise process.env par défaut
      const config = loadEnv();
      expect(config.jwtSecret).toBe(process.env.JWT_SECRET);
    } finally {
      if (originalSecret === undefined) {
        delete process.env.JWT_SECRET;
      } else {
        process.env.JWT_SECRET = originalSecret;
      }
    }
  });
});