import { jest } from "@jest/globals";
import logger from "../../src/config/logger.ts";
import { logInfo, logWarn, logError } from "../../src/utils/logger.ts";

// =============================================================================
// Legacy logger wrapper tests (utils/logger.js delegates to pino)
// =============================================================================

describe("logger utility (pino wrapper)", () => {
  let infoSpy;
  let warnSpy;
  let errorSpy;

  beforeEach(() => {
    infoSpy = jest.spyOn(logger, "info");
    warnSpy = jest.spyOn(logger, "warn");
    errorSpy = jest.spyOn(logger, "error");
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("logInfo should delegate to logger.info with event and data", () => {
    logInfo("TEST_EVENT", { key: "value" });

    expect(infoSpy).toHaveBeenCalledWith({
      event: "TEST_EVENT",
      key: "value",
    });
  });

  it("logWarn should delegate to logger.warn with event and data", () => {
    logWarn("WARN_EVENT", { ip: "1.2.3.4" });

    expect(warnSpy).toHaveBeenCalledWith({
      event: "WARN_EVENT",
      ip: "1.2.3.4",
    });
  });

  it("logError should delegate to logger.error with event and data", () => {
    logError("ERROR_EVENT", { message: "something broke" });

    expect(errorSpy).toHaveBeenCalledWith({
      event: "ERROR_EVENT",
      message: "something broke",
    });
  });

  it("logInfo should work with empty data object", () => {
    logInfo("EMPTY_EVENT", {});

    expect(infoSpy).toHaveBeenCalledWith({ event: "EMPTY_EVENT" });
  });

  it("logError should spread multiple data fields", () => {
    logError("MULTI_FIELD", { a: 1, b: 2, c: "three" });

    expect(errorSpy).toHaveBeenCalledWith({
      event: "MULTI_FIELD",
      a: 1,
      b: 2,
      c: "three",
    });
  });
});
