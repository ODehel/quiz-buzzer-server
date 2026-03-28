import { createAuthorizeMiddleware } from "../../src/middlewares/authorize.js";

describe("createAuthorizeMiddleware", () => {
  it("should pass when user has an allowed role", () => {
    const middleware = createAuthorizeMiddleware("admin", "buzzer");
    const req = { user: { role: "admin" } };

    expect(() => middleware(req)).not.toThrow();
  });

  it("should throw FORBIDDEN when user role is not in allowed list", () => {
    const middleware = createAuthorizeMiddleware("admin");
    const req = { user: { role: "buzzer" } };

    expect(() => middleware(req)).toThrow(
      expect.objectContaining({ status: 403, error: "FORBIDDEN" })
    );
  });

  it("should throw FORBIDDEN when req.user is undefined", () => {
    const middleware = createAuthorizeMiddleware("admin");
    const req = {};

    expect(() => middleware(req)).toThrow(
      expect.objectContaining({ status: 403, error: "FORBIDDEN" })
    );
  });

  it("should throw FORBIDDEN when req.user is null", () => {
    const middleware = createAuthorizeMiddleware("admin");
    const req = { user: null };

    expect(() => middleware(req)).toThrow(
      expect.objectContaining({ status: 403, error: "FORBIDDEN" })
    );
  });
});