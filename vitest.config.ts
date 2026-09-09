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
      {
        // This worktree lives inside the AIO repository tree, so a bare "vue"
        // import that misses the local store walks up into the host repo's
        // node_modules and produces a second Vue runtime (renderSlot crashes
        // with a null current instance across the two copies). Pin the single
        // copy declared by the ui workspace.
        find: /^vue$/,
        replacement: fileURLToPath(new URL("./ui/node_modules/vue", import.meta.url)),
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
