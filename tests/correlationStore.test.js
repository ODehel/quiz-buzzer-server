import {
  getCorrelationId,
  runWithCorrelationId,
} from "../src/utils/correlationStore.js";

// =============================================================================
// Correlation store (AsyncLocalStorage) tests
// =============================================================================

describe("correlationStore", () => {
  it("should return undefined outside of any context", () => {
    expect(getCorrelationId()).toBeUndefined();
  });

  it("should store and retrieve a correlation id within context", () => {
    let capturedId;

    runWithCorrelationId("abc-123", () => {
      capturedId = getCorrelationId();
    });

    expect(capturedId).toBe("abc-123");
  });

  it("should return undefined after the context exits", () => {
    runWithCorrelationId("temp-id", () => {
      // inside context
    });

    // outside context
    expect(getCorrelationId()).toBeUndefined();
  });

  it("should support nested contexts with different ids", () => {
    let outerCaptured;
    let innerCaptured;
    let outerAfterInner;

    runWithCorrelationId("outer-id", () => {
      outerCaptured = getCorrelationId();

      runWithCorrelationId("inner-id", () => {
        innerCaptured = getCorrelationId();
      });

      outerAfterInner = getCorrelationId();
    });

    expect(outerCaptured).toBe("outer-id");
    expect(innerCaptured).toBe("inner-id");
    expect(outerAfterInner).toBe("outer-id");
  });

  it("should propagate correlation id to async operations", async () => {
    let asyncCaptured;

    await new Promise((resolve) => {
      runWithCorrelationId("async-id", () => {
        setTimeout(() => {
          asyncCaptured = getCorrelationId();
          resolve();
        }, 10);
      });
    });

    expect(asyncCaptured).toBe("async-id");
  });

  it("should return the value from the callback via runWithCorrelationId", () => {
    const result = runWithCorrelationId("id-123", () => {
      return 42;
    });

    expect(result).toBe(42);
  });
});
