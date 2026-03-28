export default {
  // Integration tests using HTTP/WebSocket servers leave residual Node.js
  // handles (closed servers, IPC pipes) that can prevent Jest ESM workers
  // from exiting within the default timeout.  All test resources are properly
  // torn down — this just lets the worker exit without waiting for GC.
  forceExit: true,
  transform: {},
  coverageDirectory: "coverage",
  collectCoverageFrom: [
    "src/**/*.js",
    "!src/index.js",
    "!src/config/logger.js",
  ],
  coverageThreshold: {
    global: {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90,
    },
  },
};