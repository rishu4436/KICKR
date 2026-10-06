import { defineConfig } from "vitest/config";

/**
 * Postgres integration suite. Does not use the in-memory contest store.
 * See DEVELOPMENT.md → "Postgres integration tests".
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/pg/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
