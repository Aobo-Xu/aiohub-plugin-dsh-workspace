import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const contractDir = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(contractDir, "..", "..");
const pluginRoot = path.resolve(uiRoot, "..");

const HOST_MODULES = ["vue", "aiohub-sdk", "aiohub-ui"];
const FORBIDDEN_IMPORT =
  /(?:from|import)\s*['"][^'"]*(?:tests\/adapters|deepseek-harness|cordis|@deepseek-ai\/)[^'"]*['"]/;

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|vue)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("production UI entry contract", () => {
  it("release manifest points to the built ESM component", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(pluginRoot, "manifest.json"), "utf8"),
    ) as { ui?: { component?: string; displayName?: string } };

    expect(manifest.ui?.component).toBe("ui/dist/index.js");
    expect(manifest.ui?.displayName).toBeTruthy();
  });

  it("vite config emits a single unsplit ESM library from the source entry", async () => {
    const mod = await import("../../vite.config.ts");
    type ConfigFactory = (env: {
      command: string;
      mode: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) => any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exported = mod.default as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config: any =
      typeof exported === "function"
        ? await (exported as ConfigFactory)({ command: "build", mode: "production" })
        : exported;

    const entry = config.build?.lib?.entry;
    expect(typeof entry === "string" ? entry.replace(/\\/g, "/") : "").toContain(
      "src/entry/index.ts",
    );
    expect(config.build?.cssCodeSplit).toBe(false);

    const external = config.build?.rollupOptions?.external;
    expect(Array.isArray(external) ? [...external].sort() : external).toEqual(
      [...HOST_MODULES].sort(),
    );

    const output = config.build?.rollupOptions?.output;
    const codeSplitting = Array.isArray(output)
      ? output[0]?.codeSplitting
      : output?.codeSplitting;
    expect(codeSplitting).toBe(false);
  });

  it("source entry never imports DSH/Cordis internals or test adapters", () => {
    const files = listSourceFiles(path.join(uiRoot, "src"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(
        FORBIDDEN_IMPORT.test(text),
        `${file} must not import DSH/Cordis internals or test adapters`,
      ).toBe(false);
    }
  });
});
