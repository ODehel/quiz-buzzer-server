import { generateToken, verifyToken } from "../../src/services/tokenService.js";

const TEST_CONFIG = {
  jwtSecret: "a-test-secret-that-is-at-least-32-characters-long!!",
  jwtExpiration: 3600,
};

describe("tokenService", () => {
  const mockUser = {
    USR_ID: "018e4f5a-0000-7000-8000-000000000001",
    USR_ROLE: "admin",
  };

  describe("generateToken", () => {
    it("should return a token object with correct shape", () => {
      const result = generateToken(mockUser, TEST_CONFIG);

      expect(result).toHaveProperty("token");
      expect(result.expires_in).toBe(3600);
      expect(result.token_type).toBe("Bearer");
    });

    it("should produce a token with correct JWT claims", () => {
      const result = generateToken(mockUser, TEST_CONFIG);
      const decoded = verifyToken(result.token, TEST_CONFIG.jwtSecret);

      expect(decoded.sub).toBe(mockUser.USR_ID);
      expect(decoded.role).toBe(mockUser.USR_ROLE);
      expect(decoded).toHaveProperty("iat");
      expect(decoded).toHaveProperty("exp");
      expect(decoded.exp - decoded.iat).toBe(3600);
    });
  });

  describe("verifyToken", () => {
    it("should reject a tampered token", () => {
      const result = generateToken(mockUser, TEST_CONFIG);
      expect(() => verifyToken(result.token + "x", TEST_CONFIG.jwtSecret)).toThrow();
    });

    it("should reject a token signed with a different secret", () => {
      const result = generateToken(mockUser, TEST_CONFIG);
      expect(() => verifyToken(result.token, "wrong-secret-wrong-secret-wrong!!")).toThrow();
    });
  });
});