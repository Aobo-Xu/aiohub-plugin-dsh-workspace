import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type PlatformKey,
  type RuntimeSource,
  type VerifiedRuntime,
  resolveRuntime,
} from "./resolve-runtime.ts";
import { verifyRuntime } from "./verify-runtime.ts";

const DSH_TAG = "dsh-v0.1.2-alpha.5";
const DSH_COMMIT = "db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5";
const CONTRACT_HASH = "96af8af6cdb538da2cd13c53eb4dd640f0ca233aab68b209d82fc744e01da519";
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const runtimeClosures = {
  "win32-x64": [
    "bin/deepseek-harness-sdk-runtime-win-x64.exe",
    "bin/deepseek-harness-sdk-runtime-win-x64-rg.exe",
  ],
  "linux-x64": [
    "bin/deepseek-harness-sdk-runtime-linux-x64",
    "bin/deepseek-harness-sdk-runtime-linux-x64-rg",
  ],
  "linux-arm64": [
    "bin/deepseek-harness-sdk-runtime-linux-arm64",
    "bin/deepseek-harness-sdk-runtime-linux-arm64-rg",
  ],
  "darwin-arm64": [
    "bin/deepseek-harness-sdk-runtime-macos-arm64",
    "bin/deepseek-harness-sdk-runtime-macos-arm64-rg",
    "bin/deepseek-harness-sdk-runtime-macos-arm64-spawn-helper",
  ],
} as const;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function writeRuntimeFixture(root: string): Promise<{
  runtime: string;
  rg: string;
  sbom: string;
}> {
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(root, "sbom"), { recursive: true });
  const runtimeContent = "runtime-fixture";
  const rgContent = "rg-fixture";
  const sbomContent = JSON.stringify({
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    metadata: {
      component: {
        type: "application",
        name: "deepseek-harness-runtime",
        version: "0.1.2-alpha.5",
        licenses: [{ license: { id: "Apache-2.0" } }],
        properties: [
          { name: "aio:runtime-source", value: "project-built-from-official-source" },
          { name: "aio:contract-hash", value: CONTRACT_HASH },
        ],
      },
    },
  });
  await writeFile(
    join(root, "bin", "deepseek-harness-sdk-runtime-win-x64.exe"),
    runtimeContent
  );
  await writeFile(
    join(root, "bin", "deepseek-harness-sdk-runtime-win-x64-rg.exe"),
    rgContent
  );
  await writeFile(join(root, "sbom", "runtime.cdx.json"), sbomContent);
  return {
    runtime: sha256(runtimeContent),
    rg: sha256(rgContent),
    sbom: sha256(sbomContent),
  };
}

async function fixtureRuntime(
  fault:
    | "valid"
    | "moving-ref"
    | "temporary-actions-artifact"
    | "wrong-arch"
    | "missing-helper"
    | "checksum-mismatch"
    | "unsupported-license"
    | "contract-mismatch"
    | "pending-native-build"
    | "artifact-state-mismatch"
): Promise<VerifiedRuntime> {
  const root = await mkdtemp(join(tmpdir(), "dsh-runtime-"));
  const hashes = await writeRuntimeFixture(root);

  let source: RuntimeSource = {
    kind: "project-built-from-official-source",
    tag: DSH_TAG,
    commit: DSH_COMMIT,
  };
  if (fault === "moving-ref") {
    source = {
      kind: "project-built-from-official-source",
      tag: "moving-tag",
      commit: "0000000000000000000000000000000000000000",
    };
  }
  if (fault === "temporary-actions-artifact") {
    source = {
      kind: "official-wheel",
      url: "https://example.com/actions/runs/123/artifact/runtime.zip",
      sha256: hashes.runtime,
    };
  }

  const platform: PlatformKey =
    fault === "wrong-arch" ? "darwin-arm64" : "win32-x64";

  const files = [
    {
      path: "bin/deepseek-harness-sdk-runtime-win-x64.exe",
      sha256: hashes.runtime,
      executable: true,
    },
    {
      path: "bin/deepseek-harness-sdk-runtime-win-x64-rg.exe",
      sha256: hashes.rg,
      executable: true,
    },
    {
      path: "sbom/runtime.cdx.json",
      sha256: hashes.sbom,
      executable: false,
    },
  ];

  if (fault === "checksum-mismatch") {
    files[0] = {
      ...files[0],
      sha256: "0".repeat(64),
    };
  }

  if (fault === "missing-helper") {
    files.splice(1, 1);
  }

  if (fault === "artifact-state-mismatch") {
    files.splice(0, files.length);
  }

  return {
    platform,
    root,
    source,
    artifactState:
      fault === "pending-native-build"
        ? { status: "not-built", reason: "native-runner-required" }
        : { status: "built" },
    files,
    license: fault === "unsupported-license" ? "Proprietary" : "Apache-2.0",
    contractHash:
      fault === "contract-mismatch" ? "0".repeat(64) : CONTRACT_HASH,
    runtimeClosure: runtimeClosures["win32-x64"],
    cyclonedxPath: "sbom/runtime.cdx.json",
    nodePkgTarget: "node24-win-x64",
    toolchain: {
      node: "24",
      pnpm: "11.7.0",
      python: "3.10",
      rust: "1.89.0",
    },
  };
}

describe("runtime lock verification", () => {
  const roots: string[] = [];

  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  it.each([
    "moving-ref",
    "temporary-actions-artifact",
    "wrong-arch",
    "missing-helper",
    "checksum-mismatch",
    "unsupported-license",
    "contract-mismatch",
    "pending-native-build",
    "artifact-state-mismatch",
  ] as const)("rejects %s", async (fault) => {
    const runtime = await fixtureRuntime(fault);
    roots.push(runtime.root);

    await expect(verifyRuntime(runtime)).rejects.toMatchObject({
      code: `RUNTIME_${fault.toUpperCase().replaceAll("-", "_")}`,
    });
  });

  it("accepts a valid project-built runtime", async () => {
    const runtime = await fixtureRuntime("valid");
    roots.push(runtime.root);

    await expect(verifyRuntime(runtime)).resolves.toMatchObject({
      platform: "win32-x64",
      source: {
        kind: "project-built-from-official-source",
      },
    });
  });

  it("rejects a runtime with a missing CycloneDX SBOM", async () => {
    const runtime = await fixtureRuntime("valid");
    roots.push(runtime.root);

    runtime.cyclonedxPath = "sbom/missing.cdx.json";

    await expect(verifyRuntime(runtime)).rejects.toMatchObject({
      code: "RUNTIME_SBOM_MISSING",
    });
  });

  it("resolves the frozen alpha.5 runtime without inventing an official wheel", async () => {
    const runtime = await resolveRuntime("win32-x64");

    expect(runtime.platform).toBe("win32-x64");
    expect(runtime.source.kind).toBe("project-built-from-official-source");
    expect(runtime.artifactState).toEqual({ status: "built" });
    expect(runtime.source).toMatchObject({
      tag: DSH_TAG,
      commit: DSH_COMMIT,
    });
  });

  it("locks every supported platform to the frozen alpha.5 source", async () => {
    const lockPath = new URL(
      "../../runtime-lock/dsh-v0.1.2-alpha.5.json",
      import.meta.url
    );
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
      schemaVersion: number;
      source: RuntimeSource;
      platforms: Record<
        keyof typeof runtimeClosures,
        {
          artifactState: unknown;
          runtimeClosure: readonly string[];
          files: readonly unknown[];
        }
      >;
    };

    expect(lock.schemaVersion).toBe(1);
    expect(lock.source).toEqual({
      kind: "project-built-from-official-source",
      tag: DSH_TAG,
      commit: DSH_COMMIT,
    });
    expect(Object.keys(lock.platforms)).toEqual([
      "win32-x64",
      "linux-x64",
      "linux-arm64",
      "darwin-arm64",
    ]);
    for (const [platform, closure] of Object.entries(runtimeClosures)) {
      const isWindows = platform === "win32-x64";
      expect(lock.platforms[platform as keyof typeof runtimeClosures]).toMatchObject({
        artifactState: isWindows
          ? { status: "built" }
          : { status: "not-built", reason: "native-runner-required" },
        runtimeClosure: closure,
      });
      if (isWindows) {
        expect(lock.platforms[platform as keyof typeof runtimeClosures].files.length).toBe(3);
      } else {
        expect(lock.platforms[platform as keyof typeof runtimeClosures].files).toEqual([]);
      }
    }
  });
});

describe("runtime supply-chain CLI", () => {
  it("prints build prerequisites for source builds", () => {
    const result = spawnSync(
      "node",
      ["--experimental-strip-types", "scripts/runtime/build-from-source.ts", "--help"],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 }
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("--source-root");
    expect(result.stdout).toContain("pnpm 11.7.0");
    expect(result.stdout).toContain("Python 3.10");
  });

  it("fails closed with a stable prerequisite diagnostic", () => {
    const result = spawnSync(
      "node",
      [
        "--experimental-strip-types",
        "scripts/runtime/build-from-source.ts",
        "--source-root",
        repositoryRoot,
        "--platform",
        "win32-x64",
        "--out",
        ".artifacts/runtime-prerequisite-check",
      ],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 }
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
    expect(result.stderr).toContain(
      "RUNTIME_BUILD_PREREQUISITE_MISMATCH:"
    );
  });

  it("generates a CycloneDX document from the runtime lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sbom-"));
    const lockPath = join(root, "runtime-lock.json");
    const output = join(root, "runtime.cdx.json");
    const lock = {
      schemaVersion: 1,
      version: "0.1.2-alpha.5",
      source: { kind: "project-built-from-official-source", tag: DSH_TAG, commit: DSH_COMMIT },
      license: "MIT",
      contractHash: CONTRACT_HASH,
      platforms: {
        "win32-x64": {
          nodePkgTarget: "node24-win-x64",
          pythonTarget: "win_amd64",
        },
      },
    };
    await writeFile(lockPath, `${JSON.stringify(lock)}\n`);

    const result = spawnSync(
      "node",
      [
        "--experimental-strip-types",
        "scripts/runtime/generate-sbom.ts",
        "--lock",
        lockPath,
        "--out",
        output,
      ],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 }
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);

    const sbom = JSON.parse(await readFile(output, "utf8")) as {
      bomFormat: string;
      specVersion: string;
      metadata: { component: { name: string; version: string; licenses: { license: { id: string } }[] } };
    };
    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.specVersion).toBe("1.6");
    expect(sbom.metadata.component.name).toBe("deepseek-harness-runtime");
    expect(sbom.metadata.component.version).toBe("0.1.2-alpha.5");
    expect(sbom.metadata.component.licenses).toEqual([{ license: { id: "MIT" } }]);

    await rm(root, { recursive: true, force: true });
  });

  it.each([
    "scripts/runtime/build-from-source.ts",
    "scripts/runtime/generate-sbom.ts",
    "scripts/runtime/resolve-runtime.ts",
    "scripts/runtime/verify-runtime.ts",
  ])("prints Node-only help for %s", (script) => {
    const result = spawnSync(
      "node",
      ["--experimental-strip-types", script, "--help"],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 }
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("node --experimental-strip-types");
    expect(result.stdout).not.toContain("bun scripts/");
  });

  it("routes package runtime scripts through Node instead of Bun", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8")
    );

    for (const name of ["runtime:resolve-current", "build:dsh-source"]) {
      expect(packageJson.scripts[name]).toBeDefined();
      expect(packageJson.scripts[name]).toMatch(
        /^node --experimental-strip-types scripts\/runtime\//
      );
      expect(packageJson.scripts[name]).not.toContain("bun");
    }
  });
});
