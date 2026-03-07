import { logInfo, logWarn, logError } from "../src/utils/logger.js";

describe("logger", () => {
  let originalLog, originalWarn, originalError;
  let captured;

  beforeEach(() => {
    captured = { log: [], warn: [], error: [] };
    originalLog = console.log;
    originalWarn = console.warn;
    originalError = console.error;
    console.log = (msg) => captured.log.push(msg);
    console.warn = (msg) => captured.warn.push(msg);
    console.error = (msg) => captured.error.push(msg);
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  });

  it("logInfo should output structured JSON to console.log", () => {
    logInfo("TEST_EVENT", { key: "value" });

    expect(captured.log).toHaveLength(1);
    const parsed = JSON.parse(captured.log[0]);
    expect(parsed.level).toBe("INFO");
    expect(parsed.event).toBe("TEST_EVENT");
    expect(parsed.key).toBe("value");
    expect(parsed).toHaveProperty("timestamp");
  });

  it("logWarn should output structured JSON to console.warn", () => {
    logWarn("WARN_EVENT", { ip: "1.2.3.4" });

    expect(captured.warn).toHaveLength(1);
    const parsed = JSON.parse(captured.warn[0]);
    expect(parsed.level).toBe("WARN");
    expect(parsed.event).toBe("WARN_EVENT");
  });

  it("logError should output structured JSON to console.error", () => {
    logError("ERROR_EVENT", { message: "something broke" });

    expect(captured.error).toHaveLength(1);
    const parsed = JSON.parse(captured.error[0]);
    expect(parsed.level).toBe("ERROR");
    expect(parsed.event).toBe("ERROR_EVENT");
    expect(parsed.message).toBe("something broke");
  });
});