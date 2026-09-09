import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      {
        find: /^aiohub-sdk$/,
        replacement: fileURLToPath(new URL("./ui/tests/stubs/aiohub-sdk.ts", import.meta.url)),
      },
      {
        find: /^aiohub-ui$/,
        replacement: fileURLToPath(new URL("./ui/tests/stubs/aiohub-ui.ts", import.meta.url)),
      },
    ],
  },
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
