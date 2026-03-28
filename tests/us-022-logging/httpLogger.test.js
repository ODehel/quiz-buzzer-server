import { jest } from "@jest/globals";
import logger from "../../src/config/logger.js";
import { withHttpLogger } from "../../src/middlewares/httpLogger.js";

// =============================================================================
// CA-20 to CA-22: HTTP logger middleware tests
// =============================================================================

describe("withHttpLogger middleware", () => {
  let infoSpy;
  let req;
  let res;
  let originalEnd;

  beforeEach(() => {
    // Spy on logger.info even though it is a no-op in test mode.
    // jest.spyOn wraps the method, so calls are still recorded.
    infoSpy = jest.spyOn(logger, "info");

    originalEnd = jest.fn();
    req = {
      method: "GET",
      url: "/api/test",
      socket: { remoteAddress: "127.0.0.1" },
      correlationId: "test-corr-id-123",
    };
    res = {
      end: originalEnd,
      statusCode: 200,
    };
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  // CA-20: HTTP_REQUEST is logged on incoming request
  it("should log HTTP_REQUEST on incoming request (CA-20)", () => {
    const handler = jest.fn();
    const wrapped = withHttpLogger(handler);

    wrapped(req, res);

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "HTTP_REQUEST",
        method: "GET",
        url: "/api/test",
        ip: "127.0.0.1",
        correlation_id: "test-corr-id-123",
      })
    );
  });

  it("should log HTTP_REQUEST with 'unknown' ip when socket is missing", () => {
    const handler = jest.fn();
    const wrapped = withHttpLogger(handler);
    req.socket = undefined;

    wrapped(req, res);

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "HTTP_REQUEST",
        ip: "unknown",
      })
    );
  });

  // CA-21: HTTP_RESPONSE is logged when res.end is called
  it("should log HTTP_RESPONSE when res.end is called (CA-21)", () => {
    const handler = jest.fn();
    const wrapped = withHttpLogger(handler);

    wrapped(req, res);

    // At this point, res.end has been replaced. Call it.
    res.statusCode = 201;
    res.end("response body");

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "HTTP_RESPONSE",
        status: 201,
        correlation_id: "test-corr-id-123",
      })
    );
    // duration_ms should be a number
    const responseLog = infoSpy.mock.calls.find(
      (call) => call[0]?.event === "HTTP_RESPONSE"
    );
    expect(responseLog).toBeDefined();
    expect(typeof responseLog[0].duration_ms).toBe("number");
    expect(responseLog[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("should call the original res.end with correct arguments (CA-21)", () => {
    const handler = jest.fn();
    const wrapped = withHttpLogger(handler);

    wrapped(req, res);

    res.end("data", "utf-8");

    expect(originalEnd).toHaveBeenCalledWith("data", "utf-8");
  });

  // CA-22: Body logged only at DEBUG level
  it("should NOT include body in request log when debug is not enabled (CA-22)", () => {
    req.body = { username: "test" };
    const handler = jest.fn();
    const wrapped = withHttpLogger(handler);

    wrapped(req, res);

    const requestLog = infoSpy.mock.calls.find(
      (call) => call[0]?.event === "HTTP_REQUEST"
    );
    expect(requestLog[0].body).toBeUndefined();
  });

  it("should include body in request log when debug is enabled (CA-22)", () => {
    // Temporarily make isLevelEnabled return true for "debug"
    const isLevelSpy = jest
      .spyOn(logger, "isLevelEnabled")
      .mockReturnValue(true);

    req.body = { username: "test" };
    const handler = jest.fn();
    const wrapped = withHttpLogger(handler);

    wrapped(req, res);

    const requestLog = infoSpy.mock.calls.find(
      (call) => call[0]?.event === "HTTP_REQUEST"
    );
    expect(requestLog[0].body).toEqual({ username: "test" });

    isLevelSpy.mockRestore();
  });

  it("should call the handler with req, res, and extra args", () => {
    const handler = jest.fn();
    const wrapped = withHttpLogger(handler);

    wrapped(req, res, "extra1", "extra2");

    expect(handler).toHaveBeenCalledWith(req, res, "extra1", "extra2");
  });

  it("should wrap res.end so it is callable", () => {
    const handler = jest.fn();
    const wrapped = withHttpLogger(handler);

    wrapped(req, res);

    expect(typeof res.end).toBe("function");
    // The end function should differ from the original
    expect(res.end).not.toBe(originalEnd);
  });
});
