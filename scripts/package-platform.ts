import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { verifyRuntime, type VerifiedRuntime } from "./runtime/verify-runtime.ts";
import {
  currentPlatform,
  loadRuntimeLock,
  type PlatformKey,
} from "./runtime/resolve-runtime.ts";

export type SupportLevel = "supported" | "preview";

export type PackagePlatformOptions = {
  root: string;
  runtime: VerifiedRuntime;
  output: string;
  support: SupportLevel;
};

export type PackagePlatformResult = {
  platform: PlatformKey;
  support: SupportLevel;
  path: string;
  sha256: string;
};

const SUPPORT_LEVELS = new Set<SupportLevel>(["supported", "preview"]);

export async function packagePlatform(
  options: PackagePlatformOptions
): Promise<PackagePlatformResult> {
  if (!SUPPORT_LEVELS.has(options.support)) {
    throw new Error(`PACKAGE_SUPPORT_INVALID: ${options.support}`);
  }

  const runtime = await verifyRuntime(options.runtime);
  const staging = join(options.root, ".package-staging");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  const lockSource = await findLockFile(options.root);
  await copyFile(join(options.root, "manifest.json"), join(staging, "manifest.json"));
  await copyFile(lockSource, join(staging, "runtime-lock.json"));
  await writeFile(
    join(staging, "support-results.json"),
    JSON.stringify(
      {
        platform: runtime.platform,
        support: options.support,
        contractHash: runtime.contractHash,
      },
      null,
      2
    ) + "\n"
  );

  for (const file of runtime.files) {
    const destination = join(staging, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(runtime.root, file.path), destination);
  }

  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  const entries = [
    "manifest.json",
    "runtime-lock.json",
    "support-results.json",
    ...runtime.files.map((file) => file.path),
  ];
  const archive = spawnSync("tar", ["-a", "-cf", output, ...entries], {
    cwd: staging,
    encoding: "utf8",
  });
  if (archive.error || archive.status !== 0) {
    await rm(staging, { recursive: true, force: true });
    throw new Error(
      `PACKAGE_ARCHIVE_FAILED: ${archive.stderr || archive.error?.message || "tar failed"}`
    );
  }

  const archiveContent = await readFile(output);
  const sha256 = createHash("sha256").update(archiveContent).digest("hex");
  await rm(staging, { recursive: true, force: true });

  return {
    platform: runtime.platform,
    support: options.support,
    path: output,
    sha256,
  };
}

async function findLockFile(root: string): Promise<string> {
  const localLock = join(root, "runtime-lock.json");
  try {
    await readFile(localLock);
    return localLock;
  } catch {
    const repositoryLock = join(
      root,
      "runtime-lock",
      "dsh-v0.1.2-alpha.5.json"
    );
    await readFile(repositoryLock);
    return repositoryLock;
  }
}

async function runtimeFromRepository(
  platform: PlatformKey,
  root: string,
  runtimeRoot: string
): Promise<VerifiedRuntime> {
  const lockPath = await findLockFile(root);
  const lock = await loadRuntimeLock(lockPath);
  const spec = lock.platforms[platform];
  if (!spec) {
    throw new Error(`RUNTIME_PLATFORM_UNSUPPORTED: ${platform}`);
  }

  return {
    platform,
    root: runtimeRoot,
    source: lock.source,
    artifactState: spec.artifactState,
    files: spec.files,
    license: lock.licenseResult.spdx,
    contractHash: lock.contractHash,
    runtimeClosure: spec.runtimeClosure,
    cyclonedxPath: lock.cyclonedxPath,
    nodePkgTarget: spec.nodePkgTarget,
    toolchain: lock.toolchain,
  };
}

function usage(): string {
  return [
    "Usage: node --experimental-strip-types scripts/package-platform.ts [flags]",
    "",
    "  --platform <key>     win32-x64, linux-x64, linux-arm64, or darwin-arm64.",
    "  --runtime-root <path> Runtime artifact root.",
    "  --out <path>         Output ZIP path.",
    "  --support <level>    supported or preview.",
    "  --root <path>        Plugin repository root.",
    "  --help               Show this help.",
  ].join("\n");
}

if (import.meta.main) {
  const values = parseArgs({
    args: process.argv.slice(2),
    options: {
      platform: { type: "string" },
      "runtime-root": { type: "string" },
      out: { type: "string" },
      support: { type: "string" },
      root: { type: "string" },
      help: { type: "boolean", default: false },
    },
  }).values;

  if (values.help) {
    console.log(usage());
  } else {
    const platform =
      values.platform === undefined
        ? currentPlatform()
        : values.platform === "win32-x64" ||
            values.platform === "linux-x64" ||
            values.platform === "linux-arm64" ||
            values.platform === "darwin-arm64"
          ? values.platform
          : undefined;
    const support =
      values.support === "supported" || values.support === "preview"
        ? values.support
        : undefined;
    const repositoryRoot = values.root
      ? resolve(values.root)
      : dirname(dirname(fileURLToPath(import.meta.url)));
    const runtimeRoot = values["runtime-root"]
      ? resolve(values["runtime-root"])
      : join(repositoryRoot, ".artifacts", "runtime");
    const output =
      values.out ?? join(
        repositoryRoot,
        "dist",
        `dsh-coding-workspace-0.1.0-${platform ?? currentPlatform()}${support === "preview" ? "-preview" : ""}.zip`
      );

    if (!platform || !support) {
      console.error(usage());
      process.exitCode = 1;
    } else {
      try {
        const runtime = await runtimeFromRepository(platform, repositoryRoot, runtimeRoot);
        const result = await packagePlatform({
          root: repositoryRoot,
          runtime,
          output,
          support,
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    }
  }
}
