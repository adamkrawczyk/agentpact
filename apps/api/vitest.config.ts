import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    fileParallelism: false,
    globalSetup: ["./src/__tests__/helpers/globalSetup.ts"],
    testTimeout: 60000,
    hookTimeout: 120000,
    exclude: ["dist/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/**", "dist/**", "**/*.test.ts", "**/*.config.ts", "src/server.ts", "src/index.ts"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70
      }
    }
  }
});
