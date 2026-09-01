import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function runScript(script: string) {
  return spawnSync("bun", ["run", script], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe("plugin build gate", () => {
  test("protocol-only build succeeds before the Supervisor exists", () => {
    const result = runScript("build:protocol");

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  }, 120_000);

  test("whole-plugin build fails closed while the Supervisor is absent", () => {
    const result = runScript("build");
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain("DSH_SUPERVISOR_RUNTIME_MISSING");
  }, 120_000);
});
