export default {
  transform: {
    "^.+\\.ts$": ["@swc/jest", {
      jsc: {
        parser: {
          syntax: "typescript",
        },
        target: "es2024",
      },
      module: {
        type: "es6",
      },
    }],
  },
  extensionsToTreatAsEsm: [".ts"],
  coverageDirectory: "coverage",
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/index.ts",
    "!src/config/logger.ts",
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
