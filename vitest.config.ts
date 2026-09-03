import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Protocol/contract tests shell out to `cargo run` and `tsc`, which can
    // exceed the 5s default on a cold build cache. Match the validation
    // commands so `bun run test` is not timing-sensitive.
    testTimeout: 120_000,
    exclude: [
      "**/node_modules/**",
      "**/.worktrees/**",
      "**/target/**",
      "**/dist/**",
    ],
  },
});
