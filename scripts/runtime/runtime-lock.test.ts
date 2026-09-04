import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  type PlatformKey,
  type RuntimeSource,
  type VerifiedRuntime,
  resolveRuntime,
} from "./resolve-runtime.ts";
import {
  buildFromSource,
  persistBuiltRuntimeHashes,
  verifyPinnedSourceCheckout,
} from "./build-from-source.ts";
import { verifyRuntime } from "./verify-runtime.ts";

const DSH_TAG = "dsh-v0.1.2-alpha.5";
const DSH_COMMIT = "db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5";
const CONTRACT_HASH =
  "96af8af6cdb538da2cd13c53eb4dd640f0ca233aab68b209d82fc744e01da519";
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

it("persists the emitted runtime closure hashes for the release being packaged", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-runtime-lock-record-"));
  const lockPath = join(root, "runtime-lock.json");
  const runtimeRoot = join(root, "runtime");
  const runtime = "freshly-built-runtime";
  const rg = "freshly-built-rg";
  const sbom = "freshly-built-sbom";
  try {
    await mkdir(join(runtimeRoot, "bin"), { recursive: true });
    await mkdir(join(runtimeRoot, "sbom"), { recursive: true });
    await writeFile(join(runtimeRoot, "bin", "deepseek-harness-sdk-runtime-win-x64.exe"), runtime);
    await writeFile(join(runtimeRoot, "bin", "deepseek-harness-sdk-runtime-win-x64-rg.exe"), rg);
    await writeFile(join(runtimeRoot, "sbom", "runtime.cdx.json"), sbom);
    await writeFile(lockPath, JSON.stringify({
      schemaVersion: 1,
      version: "0.1.2-alpha.5",
      source: { kind: "project-built-from-official-source", tag: DSH_TAG, commit: DSH_COMMIT },
      licenseResult: { spdx: "MIT" },
      contractHash: CONTRACT_HASH,
      cyclonedxPath: "sbom/runtime.cdx.json",
      toolchain: { node: "24", pnpm: "11.7.0", python: "3.10", rust: "1.89.0" },
      platforms: {
        "win32-x64": {
          platform: "win32-x64",
          arch: "x64",
          artifactState: { status: "built" },
          nodePkgTarget: "node24-win-x64",
          pythonTarget: "win_amd64",
          osFloor: { kind: "windows", version: "10" },
          runtimeClosure: runtimeClosures["win32-x64"],
          files: [
            { path: "bin/deepseek-harness-sdk-runtime-win-x64.exe", sha256: "0".repeat(64), executable: true },
            { path: "bin/deepseek-harness-sdk-runtime-win-x64-rg.exe", sha256: "0".repeat(64), executable: true },
            { path: "sbom/runtime.cdx.json", sha256: "0".repeat(64), executable: false },
          ],
        },
      },
    }, null, 2));

    await persistBuiltRuntimeHashes(lockPath, runtimeRoot, "win32-x64");

    const recorded = JSON.parse(await readFile(lockPath, "utf8")) as {
      platforms: { "win32-x64": { files: Array<{ path: string; sha256: string }> } };
    };
    expect(recorded.platforms["win32-x64"].files).toEqual([
      { path: "bin/deepseek-harness-sdk-runtime-win-x64.exe", sha256: sha256(runtime), executable: true },
      { path: "bin/deepseek-harness-sdk-runtime-win-x64-rg.exe", sha256: sha256(rg), executable: true },
      { path: "sbom/runtime.cdx.json", sha256: sha256(sbom), executable: false },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createSourceFixture(
  options: {
    packageVersion?: string;
    packageLicense?: string;
    packageManager?: string;
    lockContent?: string;
  } = {},
): Promise<{
  sourceRoot: string;
  pin: {
    tag: string;
    commit: string;
    version: string;
    packageManager: string;
    sourceLockSha256: string;
    license: string;
  };
}> {
  const sourceRoot = await mkdtemp(join(tmpdir(), "dsh-source-fixture-"));
  const lockContent = options.lockContent ?? "lockfileVersion: '9.0'\n";
  const packageVersion = options.packageVersion ?? "0.1.2-alpha.5";
  const packageLicense = options.packageLicense ?? "MIT";
  const packageManager = options.packageManager ?? "pnpm@11.7.0";
  const tag = "fixture-dsh-tag";

  await writeFile(join(sourceRoot, "pnpm-lock.yaml"), lockContent);
  await writeFile(
    join(sourceRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "@deepseek-ai/dsh-root",
        version: packageVersion,
        license: packageLicense,
        packageManager,
      },
      null,
      2,
    )}\n`,
  );

  for (const args of [
    ["init"],
    ["config", "user.email", "runtime-test@example.invalid"],
    ["config", "user.name", "Runtime Test"],
    ["add", "pnpm-lock.yaml", "package.json"],
    ["commit", "-m", "fixture"],
    ["tag", tag],
  ]) {
    const result = spawnSync("git", args, {
      cwd: sourceRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  }

  const commitResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(
    commitResult.status,
    `${commitResult.stdout}${commitResult.stderr}`,
  ).toBe(0);

  return {
    sourceRoot,
    pin: {
      tag,
      commit: commitResult.stdout.trim(),
      version: packageVersion,
      packageManager,
      sourceLockSha256: sha256(lockContent),
      license: packageLicense,
    },
  };
}

async function withEnvironment<T>(
  overrides: Record<string, string | undefined>,
  work: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await work();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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
          {
            name: "aio:runtime-source",
            value: "project-built-from-official-source",
          },
          { name: "aio:contract-hash", value: CONTRACT_HASH },
        ],
      },
    },
  });
  await writeFile(
    join(root, "bin", "deepseek-harness-sdk-runtime-win-x64.exe"),
    runtimeContent,
  );
  await writeFile(
    join(root, "bin", "deepseek-harness-sdk-runtime-win-x64-rg.exe"),
    rgContent,
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
    | "artifact-state-mismatch",
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
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    );
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
      import.meta.url,
    );
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
      schemaVersion: number;
      source: RuntimeSource;
      sourcePatches: readonly {
        path: string;
        sha256: string;
        reason: string;
      }[];
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
    expect(lock.sourcePatches).toEqual([
      {
        path: "patches/dsh-alpha5-runtime-closure.patch",
        sha256:
          "66435c27835a9117bda23e51fc27f593fb0b7f854148e9b0d7161ed56689d549",
        reason: expect.stringContaining("required workspace peers"),
      },
    ]);
    expect(Object.keys(lock.platforms)).toEqual([
      "win32-x64",
      "linux-x64",
      "linux-arm64",
      "darwin-arm64",
    ]);
    for (const [platform, closure] of Object.entries(runtimeClosures)) {
      const isWindows = platform === "win32-x64";
      expect(
        lock.platforms[platform as keyof typeof runtimeClosures],
      ).toMatchObject({
        artifactState: isWindows
          ? { status: "built" }
          : { status: "not-built", reason: "native-runner-required" },
        runtimeClosure: closure,
      });
      if (isWindows) {
        expect(
          lock.platforms[platform as keyof typeof runtimeClosures].files.length,
        ).toBe(3);
      } else {
        expect(
          lock.platforms[platform as keyof typeof runtimeClosures].files,
        ).toEqual([]);
      }
    }
  });
});

describe("runtime supply-chain CLI", () => {
  it("forces pinned source patches to LF bytes in every Git checkout", () => {
    const result = spawnSync(
      "git",
      [
        "check-attr",
        "eol",
        "--",
        "patches/dsh-alpha5-runtime-closure.patch",
      ],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe(
      "patches/dsh-alpha5-runtime-closure.patch: eol: lf",
    );
  });

  it("rejects a source checkout when the pinned lock digest drifts", async () => {
    const { sourceRoot, pin } = await createSourceFixture();
    try {
      await writeFile(
        join(sourceRoot, "pnpm-lock.yaml"),
        "lockfileVersion: '10.0'\n",
      );

      await expect(
        verifyPinnedSourceCheckout(sourceRoot, pin, {
          runCommand: async (command, args, cwd) => {
            if (
              command === "git" &&
              args[0] === "status" &&
              args[1] === "--short"
            ) {
              return "";
            }

            const result = spawnSync(command, [...args], {
              cwd,
              encoding: "utf8",
              timeout: 30_000,
            });
            expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
            return result.stdout.trim();
          },
        }),
      ).rejects.toMatchObject({ code: "RUNTIME_SOURCE_LOCK_MISMATCH" });
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("rejects a Windows source build when pnpm exposes only a command shim", async () => {
    const { sourceRoot, pin } = await createSourceFixture();
    const out = join(sourceRoot, "runtime-out");
    const lock = {
      licenseResult: { spdx: "MIT" },
      source: {
        kind: "project-built-from-official-source",
        tag: DSH_TAG,
        commit: DSH_COMMIT,
      },
      platforms: {
        "win32-x64": {
          artifactState: { status: "built" },
          files: [],
          runtimeClosure: runtimeClosures["win32-x64"],
          nodePkgTarget: "node24-win-x64",
        },
      },
      cyclonedxPath: "sbom/runtime.cdx.json",
      contractHash: CONTRACT_HASH,
      toolchain: {
        node: "24",
        pnpm: "11.7.0",
        python: "3.10",
        rust: "1.89.0",
      },
    } as const;

    const commands: { command: string; args: readonly string[] }[] = [];

    try {
      await expect(
        withEnvironment(
          {
            npm_execpath: undefined,
            PNPM_HOME: undefined,
          },
          () =>
            buildFromSource(
              { sourceRoot, platform: "win32-x64", out },
              {
                pin,
                nodeVersion: "24.1.0",
                runCommand: async (command, args, cwd) => {
                  commands.push({ command, args });
                  if (command === "git") {
                    const result = spawnSync(command, [...args], {
                      cwd,
                      encoding: "utf8",
                      timeout: 30_000,
                    });
                    expect(
                      result.status,
                      `${result.stdout}${result.stderr}`,
                    ).toBe(0);
                    return result.stdout.trim();
                  }
                  if (args.at(-1) === "--version") {
                    return "11.7.0";
                  }
                  return "";
                },
                loadRuntimeLock: async () => lock,
                generateSbom: async () => undefined,
                verifyRuntime: async (runtime) => runtime,
              },
            ),
        ),
      ).rejects.toMatchObject({
        code: "RUNTIME_BUILD_PREREQUISITE_MISMATCH",
      });
      expect(commands.some(({ command }) => /pnpm\.cmd/i.test(command))).toBe(
        false,
      );
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("ignores a non-pnpm npm_execpath and resolves pnpm via PNPM_HOME on Windows", async () => {
    const { sourceRoot, pin } = await createSourceFixture();
    const out = join(sourceRoot, "runtime-out");
    const setupRoot = await mkdtemp(join(tmpdir(), "dsh-pnpm-home-"));
    const pnpmHome = join(setupRoot, "node_modules", ".bin");
    const pnpmEntrypoint = join(
      setupRoot,
      "node_modules",
      "pnpm",
      "bin",
      "pnpm.mjs",
    );
    const sbomContent = JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
    });
    const expectedRuntime = "expected-runtime";
    const expectedRg = "expected-rg";
    const recorded: { command: string; args: readonly string[] }[] = [];
    const lock = {
      licenseResult: { spdx: "MIT" },
      source: {
        kind: "project-built-from-official-source",
        tag: DSH_TAG,
        commit: DSH_COMMIT,
      },
      platforms: {
        "win32-x64": {
          artifactState: { status: "built" },
          files: [
            {
              path: "bin/deepseek-harness-sdk-runtime-win-x64.exe",
              sha256: sha256(expectedRuntime),
              executable: true,
            },
            {
              path: "bin/deepseek-harness-sdk-runtime-win-x64-rg.exe",
              sha256: sha256(expectedRg),
              executable: true,
            },
            {
              path: "sbom/runtime.cdx.json",
              sha256: sha256(sbomContent),
              executable: false,
            },
          ],
          runtimeClosure: runtimeClosures["win32-x64"],
          nodePkgTarget: "node24-win-x64",
        },
      },
      cyclonedxPath: "sbom/runtime.cdx.json",
      contractHash: CONTRACT_HASH,
      toolchain: {
        node: "24",
        pnpm: "11.7.0",
        python: "3.10",
        rust: "1.89.0",
      },
    } as const;

    try {
      await mkdir(dirname(pnpmEntrypoint), { recursive: true });
      await writeFile(pnpmEntrypoint, "");

      const runtime = await withEnvironment(
        {
          npm_execpath: "C:\\tools\\bun.exe",
          PNPM_HOME: pnpmHome,
        },
        () =>
          buildFromSource(
            { sourceRoot, platform: "win32-x64", out },
            {
              pin,
              nodeVersion: "24.1.0",
              runCommand: async (command, args, cwd) => {
                recorded.push({ command, args });
                if (command === "git") {
                  const result = spawnSync(command, [...args], {
                    cwd,
                    encoding: "utf8",
                    timeout: 30_000,
                  });
                  expect(
                    result.status,
                    `${result.stdout}${result.stderr}`,
                  ).toBe(0);
                  return result.stdout.trim();
                }
                if (args.at(-1) === "--version") {
                  return "11.7.0";
                }
                if (
                  args.some((value) =>
                    value.includes("build-exe-for-python-sdk.ts"),
                  )
                ) {
                  await mkdir(join(sourceRoot, "dist-exe"), {
                    recursive: true,
                  });
                  await writeFile(
                    join(
                      sourceRoot,
                      "dist-exe",
                      "deepseek-harness-sdk-runtime-win-x64.exe",
                    ),
                    expectedRuntime,
                  );
                  await writeFile(
                    join(
                      sourceRoot,
                      "dist-exe",
                      "deepseek-harness-sdk-runtime-win-x64-rg.exe",
                    ),
                    expectedRg,
                  );
                }
                return "";
              },
              loadRuntimeLock: async () => lock,
              generateSbom: async (runtimeRoot) => {
                await mkdir(join(runtimeRoot, "sbom"), { recursive: true });
                await writeFile(
                  join(runtimeRoot, "sbom", "runtime.cdx.json"),
                  sbomContent,
                );
              },
              verifyRuntime: async (runtime) => runtime,
            },
          ),
      );

      expect(runtime.platform).toBe("win32-x64");
      const pnpmCalls = recorded.filter(({ command }) => command !== "git");
      expect(pnpmCalls.length).toBeGreaterThanOrEqual(3);
      expect(pnpmCalls[0]).toMatchObject({
        command: process.execPath,
        args: [pnpmEntrypoint, "--version"],
      });
      expect(
        pnpmCalls.every(
          ({ command, args }) =>
            !/bun\.exe/i.test(command) &&
            args.every((value) => !/bun\.exe/i.test(value)),
        ),
      ).toBe(true);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(setupRoot, { recursive: true, force: true });
    }
  });

  it("rejects a source checkout when tracked files are dirty", async () => {
    const { sourceRoot, pin } = await createSourceFixture();
    try {
      const packagePath = join(sourceRoot, "package.json");
      const packageJson = await readFile(packagePath, "utf8");
      await writeFile(packagePath, `${packageJson.trim()}\n \n`);

      await expect(
        verifyPinnedSourceCheckout(sourceRoot, pin),
      ).rejects.toMatchObject({ code: "RUNTIME_SOURCE_DIRTY" });
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("prints build prerequisites for source builds", () => {
    const result = spawnSync(
      "node",
      [
        "--experimental-strip-types",
        "scripts/runtime/build-from-source.ts",
        "--help",
      ],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("--source-root");
    expect(result.stdout).toContain("pnpm 11.7.0");
    expect(result.stdout).toContain(
      "e12083149a77f790d39b64d018b6b8745c6a7aa95777ecb73e0a2f5ed5fdd0d9",
    );
  });

  it("rejects a source build when staged binaries drift from the runtime lock", async () => {
    const { sourceRoot, pin } = await createSourceFixture();
    const out = join(sourceRoot, "runtime-out");
    const runtimeContent = "actual-runtime";
    const rgContent = "expected-rg";
    const sbomContent = JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      metadata: {
        component: {
          type: "application",
          name: "deepseek-harness-runtime",
          version: "0.1.2-alpha.5",
          licenses: [{ license: { id: "MIT" } }],
          properties: [
            {
              name: "aio:runtime-source",
              value: "project-built-from-official-source",
            },
            {
              name: "aio:contract-hash",
              value: CONTRACT_HASH,
            },
          ],
        },
      },
    });

    try {
      const lock = {
        schemaVersion: 1,
        version: "0.1.2-alpha.5",
        tag: DSH_TAG,
        commit: DSH_COMMIT,
        publishedAt: "2026-09-02T07:48:33Z",
        source: {
          kind: "project-built-from-official-source",
          tag: DSH_TAG,
          commit: DSH_COMMIT,
        },
        officialWheel: {
          status: "unavailable",
          distributions: [
            "deepseek-harness-sdk",
            "deepseek-harness-runtime-bin",
          ],
          reason: "not-published-for-0.1.2a5",
        },
        license: "MIT",
        licenseResult: {
          spdx: "MIT",
          source: "upstream-package",
        },
        cyclonedxPath: "sbom/runtime.cdx.json",
        profileVersion: "dsh-runtime-profile-v1",
        contractHash: CONTRACT_HASH,
        aioSemverRange: ">=0.7.0-alpha.4",
        toolchain: {
          node: "24",
          pnpm: "11.7.0",
          python: "3.10",
          rust: "1.89.0",
        },
        platforms: {
          "win32-x64": {
            platform: "win32-x64",
            arch: "x64",
            artifactState: { status: "built" },
            nodePkgTarget: "node24-win-x64",
            pythonTarget: "win_amd64",
            osFloor: { kind: "windows", version: "10" },
            runtimeClosure: [
              "bin/deepseek-harness-sdk-runtime-win-x64.exe",
              "bin/deepseek-harness-sdk-runtime-win-x64-rg.exe",
            ],
            files: [
              {
                path: "bin/deepseek-harness-sdk-runtime-win-x64.exe",
                sha256: sha256("expected-runtime"),
                executable: true,
              },
              {
                path: "bin/deepseek-harness-sdk-runtime-win-x64-rg.exe",
                sha256: sha256(rgContent),
                executable: true,
              },
              {
                path: "sbom/runtime.cdx.json",
                sha256: sha256(sbomContent),
                executable: false,
              },
            ],
          },
          "linux-x64": {
            platform: "linux-x64",
            arch: "x64",
            artifactState: {
              status: "not-built",
              reason: "native-runner-required",
            },
            nodePkgTarget: "node24-linux-x64",
            pythonTarget: "manylinux_2_28_x86_64",
            osFloor: { kind: "glibc", version: "2.28" },
            runtimeClosure: [
              "bin/deepseek-harness-sdk-runtime-linux-x64",
              "bin/deepseek-harness-sdk-runtime-linux-x64-rg",
            ],
            files: [],
          },
          "linux-arm64": {
            platform: "linux-arm64",
            arch: "arm64",
            artifactState: {
              status: "not-built",
              reason: "native-runner-required",
            },
            nodePkgTarget: "node24-linux-arm64",
            pythonTarget: "manylinux_2_28_aarch64",
            osFloor: { kind: "glibc", version: "2.28" },
            runtimeClosure: [
              "bin/deepseek-harness-sdk-runtime-linux-arm64",
              "bin/deepseek-harness-sdk-runtime-linux-arm64-rg",
            ],
            files: [],
          },
          "darwin-arm64": {
            platform: "darwin-arm64",
            arch: "arm64",
            artifactState: {
              status: "not-built",
              reason: "native-runner-required",
            },
            nodePkgTarget: "node24-macos-arm64",
            pythonTarget: "macosx_14_0_arm64",
            osFloor: { kind: "macos", version: "14.0" },
            runtimeClosure: [
              "bin/deepseek-harness-sdk-runtime-macos-arm64",
              "bin/deepseek-harness-sdk-runtime-macos-arm64-rg",
              "bin/deepseek-harness-sdk-runtime-macos-arm64-spawn-helper",
            ],
            files: [],
          },
        },
      } as const;

      const runCommand = async (
        command: string,
        args: readonly string[],
        cwd: string,
      ): Promise<string> => {
        if (command === "git") {
          const result = spawnSync(command, [...args], {
            cwd,
            encoding: "utf8",
            timeout: 30_000,
          });
          expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
          return result.stdout.trim();
        }
        if (args.at(-1) === "--version") {
          return "11.7.0";
        }
        if (
          args.some((value) => value.includes("build-exe-for-python-sdk.ts")) ||
          args[0] === "exec"
        ) {
          await mkdir(join(sourceRoot, "dist-exe"), { recursive: true });
          await writeFile(
            join(
              sourceRoot,
              "dist-exe",
              "deepseek-harness-sdk-runtime-win-x64.exe",
            ),
            runtimeContent,
          );
          await writeFile(
            join(
              sourceRoot,
              "dist-exe",
              "deepseek-harness-sdk-runtime-win-x64-rg.exe",
            ),
            rgContent,
          );
        }
        return "";
      };

      await expect(
        buildFromSource(
          { sourceRoot, platform: "win32-x64", out },
          {
            pin,
            nodeVersion: "24.1.0",
            runCommand,
            resolvePnpmCommand: () => ({ command: "pnpm", args: [] }),
            loadRuntimeLock: async () => lock,
            generateSbom: async (runtimeRoot) => {
              await mkdir(join(runtimeRoot, "sbom"), { recursive: true });
              await writeFile(
                join(runtimeRoot, "sbom", "runtime.cdx.json"),
                sbomContent,
              );
            },
          },
        ),
      ).rejects.toMatchObject({ code: "RUNTIME_CHECKSUM_MISMATCH" });
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("generates a CycloneDX document from the runtime lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sbom-"));
    const lockPath = join(root, "runtime-lock.json");
    const output = join(root, "runtime.cdx.json");
    const lock = {
      schemaVersion: 1,
      version: "0.1.2-alpha.5",
      source: {
        kind: "project-built-from-official-source",
        tag: DSH_TAG,
        commit: DSH_COMMIT,
      },
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
      { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);

    const sbom = JSON.parse(await readFile(output, "utf8")) as {
      bomFormat: string;
      specVersion: string;
      metadata: {
        component: {
          name: string;
          version: string;
          licenses: { license: { id: string } }[];
        };
      };
    };
    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.specVersion).toBe("1.6");
    expect(sbom.metadata.component.name).toBe("deepseek-harness-runtime");
    expect(sbom.metadata.component.version).toBe("0.1.2-alpha.5");
    expect(sbom.metadata.component.licenses).toEqual([
      { license: { id: "MIT" } },
    ]);

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
      { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("node --experimental-strip-types");
    expect(result.stdout).not.toContain("bun scripts/");
  });

  it("routes package runtime scripts through Node instead of Bun", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    );

    for (const name of ["runtime:resolve-current", "build:dsh-source"]) {
      expect(packageJson.scripts[name]).toBeDefined();
      expect(packageJson.scripts[name]).toMatch(
        /^node --experimental-strip-types scripts\/runtime\//,
      );
      expect(packageJson.scripts[name]).not.toContain("bun");
    }
  });
});
