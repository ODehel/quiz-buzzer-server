import { RateLimiter } from "../../src/middlewares/rateLimiter.js";

describe("RateLimiter", () => {
  let limiter;

  beforeEach(() => {
    limiter = new RateLimiter(5, 60_000);
  });

  it("should allow up to maxRequests calls", () => {
    for (let i = 0; i < 5; i++) {
      expect(limiter.check("192.168.1.1").allowed).toBe(true);
    }
  });

  it("should block the 6th request from same IP", () => {
    for (let i = 0; i < 5; i++) limiter.check("192.168.1.1");

    const result = limiter.check("192.168.1.1");
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBe(60);
  });

  it("should not affect different IPs", () => {
    for (let i = 0; i < 5; i++) limiter.check("192.168.1.1");

    expect(limiter.check("192.168.1.2").allowed).toBe(true);
  });

  it("should reset properly", () => {
    for (let i = 0; i < 5; i++) limiter.check("192.168.1.1");
    limiter.reset();
    expect(limiter.check("192.168.1.1").allowed).toBe(true);
  });
});