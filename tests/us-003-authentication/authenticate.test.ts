import { createAuthenticateMiddleware } from "../../src/middlewares/authenticate.ts";
import { generateToken } from "../../src/services/tokenService.ts";

const JWT_SECRET = "a-test-secret-that-is-at-least-32-characters-long!!";

describe("createAuthenticateMiddleware", () => {
  const middleware = createAuthenticateMiddleware(JWT_SECRET);

  it("should set req.user when a valid Bearer token is provided", () => {
    const token = generateToken(
      { USR_ID: "test-id-001", USR_ROLE: "admin" },
      { jwtSecret: JWT_SECRET, jwtExpiration: 3600 }
    );

    const req = { headers: { authorization: `Bearer ${token.token}` } };
    middleware(req);

    expect(req.user).toBeDefined();
    expect(req.user.sub).toBe("test-id-001");
    expect(req.user.role).toBe("admin");
  });

  it("should throw UNAUTHORIZED when Authorization header is missing", () => {
    const req = { headers: {} };

    expect(() => middleware(req)).toThrow(
      expect.objectContaining({ status: 401, error: "UNAUTHORIZED" })
    );
  });

  it("should throw UNAUTHORIZED when Authorization header has wrong scheme", () => {
    const req = { headers: { authorization: "Basic abc123" } };

    expect(() => middleware(req)).toThrow(
      expect.objectContaining({ status: 401, error: "UNAUTHORIZED" })
    );
  });

  it("should throw UNAUTHORIZED when token is invalid", () => {
    const req = { headers: { authorization: "Bearer invalid.token.here" } };

    expect(() => middleware(req)).toThrow(
      expect.objectContaining({ status: 401, error: "UNAUTHORIZED" })
    );
  });

  it("should throw UNAUTHORIZED when token is signed with a different secret", () => {
    const token = generateToken(
      { USR_ID: "test-id-001", USR_ROLE: "admin" },
      { jwtSecret: "a-DIFFERENT-secret-at-least-32-chars-long!!", jwtExpiration: 3600 }
    );

    const req = { headers: { authorization: `Bearer ${token.token}` } };

    expect(() => middleware(req)).toThrow(
      expect.objectContaining({ status: 401, error: "UNAUTHORIZED" })
    );
  });
});