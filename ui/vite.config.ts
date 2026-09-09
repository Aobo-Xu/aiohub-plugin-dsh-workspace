import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const contractHash = readFileSync(
  fileURLToPath(new URL("../generated/protocol.sha256", import.meta.url)),
  "utf8",
).trim();

export default defineConfig({
  define: {
    __DSH_CONTRACT_HASH__: JSON.stringify(contractHash),
  },
  plugins: [vue()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: fileURLToPath(new URL("./src/entry/index.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "index.js",
      cssFileName: "index",
    },
    rollupOptions: {
      external: ["vue", "aiohub-sdk", "aiohub-ui"],
      output: {
        codeSplitting: false,
      },
    },
  },
});
