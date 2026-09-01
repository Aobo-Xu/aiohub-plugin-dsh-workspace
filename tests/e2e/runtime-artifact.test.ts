import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const roots: string[] = [];

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("runtime artifact CLI", () => {
  it("verifies a release-shaped runtime fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-runtime-cli-"));
    roots.push(root);
    const lockPath = join(root, "runtime-lock.json");
    const runtimeRoot = join(root, "runtime");
    const runtimeContent = "release-shaped runtime fixture";
    const rgContent = "release-shaped ripgrep fixture";
    const sbomContent = JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
    });

    await mkdir(join(runtimeRoot, "bin"), { recursive: true });
    await mkdir(join(runtimeRoot, "sbom"), { recursive: true });
    await writeFile(
      join(runtimeRoot, "bin", "deepseek-harness-sdk-runtime-win-x64.exe"),
      runtimeContent
    );
    await writeFile(
      join(runtimeRoot, "bin", "deepseek-harness-sdk-runtime-win-x64-rg.exe"),
      rgContent
    );
    await writeFile(
      join(runtimeRoot, "sbom", "runtime.cdx.json"),
      sbomContent
    );

    const runtimeClosure = [
      "bin/deepseek-harness-sdk-runtime-win-x64.exe",
      "bin/deepseek-harness-sdk-runtime-win-x64-rg.exe",
    ];
    const files = [
      ...runtimeClosure.map((path, index) => ({
        path,
        sha256: index === 0 ? sha256(runtimeContent) : sha256(rgContent),
        executable: true,
      })),
      {
        path: "sbom/runtime.cdx.json",
        sha256: sha256(sbomContent),
        executable: false,
      },
    ];

    await writeFile(lockPath, JSON.stringify({
      schemaVersion: 1,
      tag: "dsh-v0.1.2-alpha.3",
      commit: "dd6322d604e00eec1ba5e0c8541159906a21094a",
      platform: "win32-x64",
      arch: "x64",
      artifactState: { status: "built" },
      source: {
        kind: "project-built-from-official-source",
        tag: "dsh-v0.1.2-alpha.3",
        commit: "dd6322d604e00eec1ba5e0c8541159906a21094a",
      },
      nodePkgTarget: "node24-win-x64",
      toolchain: {
        node: "24",
        pnpm: "11.7.0",
        python: "3.10",
        rust: "1.89.0",
      },
      files,
      runtimeClosure,
      license: "MIT",
      cyclonedxPath: "sbom/runtime.cdx.json",
      profileVersion: "dsh-runtime-profile-v1",
      contractHash: "96af8af6cdb538da2cd13c53eb4dd640f0ca233aab68b209d82fc744e01da519",
      aioSemverRange: ">=0.7.0-alpha.4",
    }));

    const result = spawnSync(
      "bun",
      [
        "scripts/runtime/verify-runtime.ts",
        "--lock",
        lockPath,
        "--root",
        runtimeRoot,
        "--platform",
        "win32-x64",
        "--offline",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 120_000,
      }
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("runtime verified: win32-x64");
  });
});
