import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  verifyRuntime,
  type VerifiedRuntime,
} from "./runtime/verify-runtime.ts";
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
  supervisorPath?: string;
};

export type PackagePlatformResult = {
  platform: PlatformKey;
  support: SupportLevel;
  path: string;
  sha256: string;
  checksumPath: string;
};

const SUPPORT_LEVELS = new Set<SupportLevel>(["supported", "preview"]);
const RELEASE_PLATFORM: PlatformKey = "win32-x64";
export async function packagePlatform(
  options: PackagePlatformOptions,
): Promise<PackagePlatformResult> {
  if (!SUPPORT_LEVELS.has(options.support)) {
    throw new Error(`PACKAGE_SUPPORT_INVALID: ${options.support}`);
  }
  if (
    options.runtime.platform !== RELEASE_PLATFORM ||
    options.support !== "supported"
  ) {
    throw new Error(
      `PACKAGE_PLATFORM_UNSUPPORTED: ${options.runtime.platform} (${options.support})`,
    );
  }

  const runtime = await verifyRuntime(options.runtime);
  const staging = join(options.root, ".package-staging");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  const lockSource = await findLockFile(options.root);
  const manifest = await readManifest(options.root, runtime.platform);
  const lock = await readPlatformLock(lockSource, runtime.platform);
  await writeFile(
    join(staging, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await writeFile(
    join(staging, "support-results.json"),
    JSON.stringify(
      {
        platform: runtime.platform,
        support: options.support,
        contractHash: runtime.contractHash,
      },
      null,
      2,
    ) + "\n",
  );

  for (const file of runtime.files) {
    const destination = join(staging, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(runtime.root, file.path), destination);
  }

  const supervisorPath =
    options.supervisorPath ??
    join(options.root, manifest.sidecar.executable[runtime.platform]);
  const supervisorDestination = join(
    staging,
    manifest.sidecar.executable[runtime.platform],
  );
  await mkdir(dirname(supervisorDestination), { recursive: true });
  try {
    await copyFile(supervisorPath, supervisorDestination);
  } catch {
    await rm(staging, { recursive: true, force: true });
    throw new Error(`PACKAGE_SUPERVISOR_MISSING: ${supervisorPath}`);
  }

  const releaseLock = {
    ...lock,
    releaseClosure: [
      {
        path: manifest.sidecar.executable[runtime.platform],
        sha256: await sha256File(supervisorDestination),
        executable: true,
      },
      ...runtime.files,
    ],
  };
  await writeFile(
    join(staging, "runtime-lock.json"),
    JSON.stringify(releaseLock, null, 2) + "\n",
  );

  await mkdir(join(staging, "licenses"), { recursive: true });
  await copyFile(
    join(options.root, "LICENSE"),
    join(staging, "licenses", "aio-dsh-supervisor-Apache-2.0.txt"),
  );

  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  const entries = [
    "manifest.json",
    "runtime-lock.json",
    "support-results.json",
    "licenses/runtime-MIT.txt",
    "licenses/runtime-THIRD_PARTY_NOTICES.md",
    "licenses/aio-dsh-supervisor-Apache-2.0.txt",
    manifest.sidecar.executable[runtime.platform],
    ...runtime.files.map((file) => file.path),
  ];
  const archive = spawnSync("tar", ["-a", "-cf", output, ...entries], {
    cwd: staging,
    encoding: "utf8",
  });
  if (archive.error || archive.status !== 0) {
    await rm(staging, { recursive: true, force: true });
    throw new Error(
      `PACKAGE_ARCHIVE_FAILED: ${archive.stderr || archive.error?.message || "tar failed"}`,
    );
  }

  const archiveContent = await readFile(output);
  const sha256 = createHash("sha256").update(archiveContent).digest("hex");
  const checksumPath = `${output}.sha256`;
  await writeFile(checksumPath, `${sha256}  ${basename(output)}\n`);
  await rm(staging, { recursive: true, force: true });

  return {
    platform: runtime.platform,
    support: options.support,
    path: output,
    sha256,
    checksumPath,
  };
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

type ReleaseManifest = {
  host: { platforms: string[] };
  sidecar: { executable: Record<PlatformKey, string> };
  [key: string]: unknown;
};

async function readManifest(
  root: string,
  platform: PlatformKey,
): Promise<ReleaseManifest> {
  const manifest = JSON.parse(
    await readFile(join(root, "manifest.json"), "utf8"),
  ) as ReleaseManifest;
  const executable = manifest.sidecar?.executable?.[platform];
  if (!executable) {
    throw new Error(
      `PACKAGE_SUPERVISOR_MISSING: manifest has no ${platform} executable`,
    );
  }
  return {
    ...manifest,
    host: { ...manifest.host, platforms: [platform] },
    sidecar: { ...manifest.sidecar, executable: { [platform]: executable } },
  } as ReleaseManifest;
}

async function readPlatformLock(
  lockPath: string,
  platform: PlatformKey,
): Promise<Record<string, unknown>> {
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as Record<
    string,
    unknown
  >;
  const platforms = lock.platforms;
  if (typeof platforms !== "object" || platforms === null) {
    if (lock.platform !== platform) {
      throw new Error(`PACKAGE_LOCK_PLATFORM_MISMATCH: ${lockPath}`);
    }
    return lock;
  }
  const platformSpec = (platforms as Record<string, unknown>)[platform];
  if (typeof platformSpec !== "object" || platformSpec === null) {
    throw new Error(`PACKAGE_LOCK_PLATFORM_MISSING: ${platform}`);
  }
  const { platforms: _platforms, ...shared } = lock;
  return { ...shared, ...(platformSpec as Record<string, unknown>) };
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
      "dsh-runtime.json",
    );
    await readFile(repositoryLock);
    return repositoryLock;
  }
}

async function runtimeFromRepository(
  platform: PlatformKey,
  root: string,
  runtimeRoot: string,
): Promise<VerifiedRuntime> {
  const lockPath = await findLockFile(root);
  const lock = await loadRuntimeLock(lockPath);
  const spec = lock.platforms[platform];
  if (!spec) {
    throw new Error(`RUNTIME_PLATFORM_UNSUPPORTED: ${platform}`);
  }

  return {
    version: lock.version,
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
    "  --platform <key>     win32-x64 (the only supported first-release platform).",
    "  --runtime-root <path> Runtime artifact root.",
    "  --out <path>         Output ZIP path.",
    "  --support <level>    supported (default).",
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
        : values.platform === RELEASE_PLATFORM
          ? values.platform
          : undefined;
    const support =
      values.support === undefined || values.support === "supported"
        ? "supported"
        : undefined;
    const repositoryRoot = values.root
      ? resolve(values.root)
      : dirname(dirname(fileURLToPath(import.meta.url)));
    const runtimeRoot = values["runtime-root"]
      ? resolve(values["runtime-root"])
      : join(repositoryRoot, ".artifacts", "runtime");
    const output =
      values.out ??
      join(
        repositoryRoot,
        "dist",
        `dsh-coding-workspace-0.1.0-${platform ?? currentPlatform()}${support === "preview" ? "-preview" : ""}.zip`,
      );

    if (!platform || !support) {
      console.error(usage());
      process.exitCode = 1;
    } else {
      try {
        const runtime = await runtimeFromRepository(
          platform,
          repositoryRoot,
          runtimeRoot,
        );
        const supervisorPath = buildSupervisor(repositoryRoot, platform);
        const result = await packagePlatform({
          root: repositoryRoot,
          runtime,
          output,
          support,
          supervisorPath,
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    }
  }
}

function buildSupervisor(root: string, platform: PlatformKey): string {
  if (platform !== RELEASE_PLATFORM) {
    throw new Error(`PACKAGE_PLATFORM_UNSUPPORTED: ${platform}`);
  }
  const build = spawnSync(
    "cargo",
    ["build", "-p", "aio-dsh-supervisor", "--release"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  if (build.error || build.status !== 0) {
    throw new Error(
      `PACKAGE_SUPERVISOR_BUILD_FAILED: ${build.stderr || build.error?.message || "cargo build failed"}`,
    );
  }
  return join(root, "target", "release", "aio-dsh-supervisor.exe");
}
