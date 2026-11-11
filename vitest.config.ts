import { defineConfig } from "vitest/config";

// No Cloudflare plugin: tests run in plain Node against the ports and fakes.
export default defineConfig({
  test: {
    environment: "node",
    // Not UTC (CI's default), so code that takes the local date where it should take the UTC one fails everywhere.
    env: { TZ: "Asia/Kolkata" },
    include: [
      "src/**/*.test.ts",
      "scripts/**/*.test.ts",
      "probes/**/*.test.ts",
      "evals/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
  },
});
