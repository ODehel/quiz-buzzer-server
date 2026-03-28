import { jest } from "@jest/globals";
import { withCorrelationId } from "../src/middlewares/correlationId.js";
import { getCorrelationId } from "../src/utils/correlationStore.js";

// =============================================================================
// CA-16 to CA-18: Correlation ID middleware tests
// =============================================================================

// UUIDv7 regex: 8-4-4-4-12 hex with version 7 in the third group
const UUID_V7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("withCorrelationId middleware", () => {
  let req;
  let res;

  beforeEach(() => {
    req = {};
    res = { setHeader: jest.fn() };
  });

  // CA-16: req.correlationId is a valid UUIDv7
  it("should set req.correlationId as a valid UUIDv7 (CA-16)", () => {
    const handler = jest.fn();
    const wrapped = withCorrelationId(handler);

    wrapped(req, res);

    expect(req.correlationId).toBeDefined();
    expect(req.correlationId).toMatch(UUID_V7_REGEX);
  });

  // CA-17: req.correlationId is set before handler is called
  it("should set req.correlationId before calling the handler (CA-17)", () => {
    let capturedId;
    const handler = jest.fn((r) => {
      capturedId = r.correlationId;
    });
    const wrapped = withCorrelationId(handler);

    wrapped(req, res);

    expect(capturedId).toBeDefined();
    expect(capturedId).toMatch(UUID_V7_REGEX);
  });

  // CA-18: X-Correlation-Id response header is set
  it("should set X-Correlation-Id response header (CA-18)", () => {
    const handler = jest.fn();
    const wrapped = withCorrelationId(handler);

    wrapped(req, res);

    expect(res.setHeader).toHaveBeenCalledWith(
      "X-Correlation-Id",
      req.correlationId
    );
  });

  it("should call the handler with original req, res, and extra args", () => {
    const handler = jest.fn();
    const wrapped = withCorrelationId(handler);
    const extra1 = "arg1";
    const extra2 = "arg2";

    wrapped(req, res, extra1, extra2);

    expect(handler).toHaveBeenCalledWith(req, res, extra1, extra2);
  });

  it("should generate a unique correlationId for each request", () => {
    const handler = jest.fn();
    const wrapped = withCorrelationId(handler);

    const req1 = {};
    const req2 = {};
    const res1 = { setHeader: jest.fn() };
    const res2 = { setHeader: jest.fn() };

    wrapped(req1, res1);
    wrapped(req2, res2);

    expect(req1.correlationId).not.toBe(req2.correlationId);
  });

  it("should propagate correlationId via AsyncLocalStorage (CA-27 support)", () => {
    let capturedStoreId;
    const handler = jest.fn(() => {
      capturedStoreId = getCorrelationId();
    });
    const wrapped = withCorrelationId(handler);

    wrapped(req, res);

    expect(capturedStoreId).toBe(req.correlationId);
  });
});
