import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  DSH_COMMIT,
  DSH_TAG,
  DSH_VERSION,
  type PlatformKey,
  type RuntimeLockV1,
  type VerifiedRuntime,
  currentPlatform,
  loadRuntimeLock,
} from "./resolve-runtime.ts";
import { verifyRuntime } from "./verify-runtime.ts";

const repositoryRoot = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);
const runtimeLockPath = join(
  repositoryRoot,
  "runtime-lock",
  "dsh-v0.1.2-alpha.5.json",
);
const WINDOWS_PLATFORM: PlatformKey = "win32-x64";
const WINDOWS_TARGET = "node24-win-x64";
const WINDOWS_RUNTIME = "deepseek-harness-sdk-runtime-win-x64.exe";
const WINDOWS_RG = "deepseek-harness-sdk-runtime-win-x64-rg.exe";
const REQUIRED_PNPM = "11.7.0";
const REQUIRED_NODE_MAJOR = "24";
const EXPECTED_SOURCE_LOCK_SHA256 =
  "e12083149a77f790d39b64d018b6b8745c6a7aa95777ecb73e0a2f5ed5fdd0d9";
const SOURCE_PATCH_RELATIVE = "patches/dsh-alpha5-runtime-closure.patch";
const EXPECTED_SOURCE_PATCH_SHA256 =
  "66435c27835a9117bda23e51fc27f593fb0b7f854148e9b0d7161ed56689d549";

export type BuildFromSourceOptions = {
  sourceRoot: string;
  platform: PlatformKey;
  out: string;
};

export type SourceBuildPin = {
  tag: string;
  commit: string;
  version: string;
  packageManager: string;
  sourceLockSha256: string;
  license: string;
};

type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
  code?: string,
) => Promise<string>;

type PnpmCommand = {
  command: string;
  args: readonly string[];
};

type BuildFromSourceOverrides = {
  pin?: SourceBuildPin;
  lockPath?: string;
  nodeVersion?: string;
  repositoryRoot?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runCommand?: CommandRunner;
  resolvePnpmCommand?: () => PnpmCommand;
  loadRuntimeLock?: (path?: string) => Promise<RuntimeLockV1>;
  verifyRuntime?: (runtime: VerifiedRuntime) => Promise<VerifiedRuntime>;
  generateSbom?: (out: string, lockPath: string) => Promise<void>;
};

export class RuntimeBuildError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RuntimeBuildError";
    this.code = code;
  }
}

/**
 * Record the hashes of the closure emitted by this source build. `pkg` embeds
 * non-deterministic metadata, so its executable hash is a release artifact
 * fact, while source, patch, and toolchain pins remain the reproducible input
 * baseline. The resulting lock is what offline packaging and startup verify.
 */
export async function persistBuiltRuntimeHashes(
  lockPath: string,
  runtimeRoot: string,
  platform: PlatformKey,
): Promise<RuntimeLockV1> {
  const payload = JSON.parse(await readFile(lockPath, "utf8")) as RuntimeLockV1;
  const files = payload.platforms?.[platform]?.files;
  if (!files || files.length === 0) {
    fail("RUNTIME_LOCK_INVALID", `missing built runtime files for ${platform}`);
  }
  for (const file of files) {
    const content = await readFile(join(runtimeRoot, file.path));
    file.sha256 = createHash("sha256").update(content).digest("hex");
  }
  await writeFile(lockPath, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

const defaultPin: SourceBuildPin = {
  tag: DSH_TAG,
  commit: DSH_COMMIT,
  version: DSH_VERSION,
  packageManager: `pnpm@${REQUIRED_PNPM}`,
  sourceLockSha256: EXPECTED_SOURCE_LOCK_SHA256,
  license: "MIT",
};

function fail(code: string, message: string): never {
  throw new RuntimeBuildError(code, message);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  code = "RUNTIME_BUILD_UPSTREAM_FAILED",
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, CI: "true" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      reject(
        new RuntimeBuildError(
          code,
          `${command} could not start: ${error.message}`,
        ),
      );
    });
    child.once("close", (status) => {
      if (status === 0) {
        resolvePromise(stdout.trim());
        return;
      }
      const detail = stderr.trim() || stdout.trim() || "no output";
      reject(
        new RuntimeBuildError(
          code,
          `${command} ${args.join(" ")} failed with exit ${status ?? "unknown"}: ${detail}`,
        ),
      );
    });
  });
}

function resolvePnpmCommandForEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): PnpmCommand {
  const npmExecPath = environment.npm_execpath?.trim();
  if (npmExecPath) {
    const extension = extname(npmExecPath).toLowerCase();
    if (extension === ".js" || extension === ".cjs" || extension === ".mjs") {
      return { command: process.execPath, args: [npmExecPath] };
    }
    if (platform !== "win32" || extension !== ".cmd") {
      return { command: npmExecPath, args: [] };
    }
  }

  const pnpmHome = environment.PNPM_HOME?.trim();
  if (pnpmHome) {
    const searchRoots =
      platform === "win32"
        ? [resolve(pnpmHome, "..", "pnpm", "bin")]
        : [pnpmHome];
    const filenames =
      platform === "win32"
        ? ["pnpm.mjs", "pnpm.cjs"]
        : ["pnpm.cjs", "pnpm.mjs", "pnpm.cmd"];

    for (const root of searchRoots) {
      for (const filename of filenames) {
        const candidate = resolve(root, filename);
        if (!existsSync(candidate)) {
          continue;
        }
        const extension = extname(candidate).toLowerCase();
        if (
          extension === ".js" ||
          extension === ".cjs" ||
          extension === ".mjs"
        ) {
          return { command: process.execPath, args: [candidate] };
        }
        return { command: candidate, args: [] };
      }
    }
  }

  if (platform === "win32") {
    fail(
      "RUNTIME_BUILD_PREREQUISITE_MISMATCH",
      "pnpm must expose a JavaScript entrypoint through npm_execpath or PNPM_HOME on Windows.",
    );
  }

  return { command: "pnpm", args: [] };
}

function resolvePnpmCommand(): PnpmCommand {
  return resolvePnpmCommandForEnvironment(process.env, process.platform);
}

async function readPinnedPackage(sourceRoot: string): Promise<{
  version?: unknown;
  license?: unknown;
  packageManager?: unknown;
}> {
  const packagePath = join(sourceRoot, "package.json");
  try {
    return JSON.parse(await readFile(packagePath, "utf8")) as {
      version?: unknown;
      license?: unknown;
      packageManager?: unknown;
    };
  } catch {
    fail(
      "RUNTIME_SOURCE_PACKAGE_INVALID",
      `DSH source package.json is missing or invalid: ${packagePath}`,
    );
  }
}

async function verifyCleanWorktree(
  sourceRoot: string,
  runCommand: CommandRunner,
): Promise<void> {
  const status = await runCommand(
    "git",
    ["status", "--short", "--untracked-files=all"],
    sourceRoot,
    "RUNTIME_SOURCE_GIT_INVALID",
  );
  if (status !== "") {
    fail(
      "RUNTIME_SOURCE_DIRTY",
      "DSH source checkout must be clean before building a pinned runtime.",
    );
  }
}

export async function verifyPinnedSourceCheckout(
  sourceRoot: string,
  pin: SourceBuildPin = defaultPin,
  overrides: Pick<BuildFromSourceOverrides, "runCommand"> = {},
): Promise<void> {
  const resolvedRoot = resolve(sourceRoot);
  const runCommand = overrides.runCommand ?? run;

  try {
    const metadata = await stat(resolvedRoot);
    if (!metadata.isDirectory()) {
      fail(
        "RUNTIME_SOURCE_MISSING",
        `DSH source checkout is not a directory: ${resolvedRoot}`,
      );
    }
  } catch {
    fail(
      "RUNTIME_SOURCE_MISSING",
      `DSH source checkout is missing: ${resolvedRoot}`,
    );
  }

  const tags = await runCommand(
    "git",
    ["tag", "--points-at", "HEAD"],
    resolvedRoot,
    "RUNTIME_SOURCE_GIT_INVALID",
  );
  if (!tags.split(/\r?\n/).includes(pin.tag)) {
    fail("RUNTIME_SOURCE_TAG_MISMATCH", `DSH source must point at ${pin.tag}`);
  }

  const head = await runCommand(
    "git",
    ["rev-parse", "HEAD"],
    resolvedRoot,
    "RUNTIME_SOURCE_GIT_INVALID",
  );
  if (head !== pin.commit) {
    fail(
      "RUNTIME_SOURCE_COMMIT_MISMATCH",
      `DSH source must be ${pin.commit}, got ${head}`,
    );
  }

  await verifyCleanWorktree(resolvedRoot, runCommand);

  const lockPath = join(resolvedRoot, "pnpm-lock.yaml");
  let lockContent: string;
  try {
    lockContent = await readFile(lockPath, "utf8");
  } catch {
    fail(
      "RUNTIME_SOURCE_LOCK_MISSING",
      `DSH source must include pnpm-lock.yaml: ${lockPath}`,
    );
  }

  const lockDigest = sha256(lockContent);
  if (lockDigest !== pin.sourceLockSha256.toLowerCase()) {
    fail(
      "RUNTIME_SOURCE_LOCK_MISMATCH",
      `DSH source lock must hash to ${pin.sourceLockSha256}, got ${lockDigest}`,
    );
  }

  const packageJson = await readPinnedPackage(resolvedRoot);
  if (packageJson.version !== pin.version) {
    fail(
      "RUNTIME_SOURCE_VERSION_MISMATCH",
      `DSH source must be version ${pin.version}, got ${String(packageJson.version)}`,
    );
  }
  if (packageJson.license !== pin.license) {
    fail(
      "RUNTIME_SOURCE_LICENSE_MISMATCH",
      `DSH source license must be ${pin.license}, got ${String(packageJson.license)}`,
    );
  }
  if (packageJson.packageManager !== pin.packageManager) {
    fail(
      "RUNTIME_SOURCE_PNPM_MISMATCH",
      `DSH source must pin ${pin.packageManager}, got ${String(packageJson.packageManager)}`,
    );
  }
}

async function verifyToolchain(
  sourceRoot: string,
  runCommand: CommandRunner,
  resolvePnpm: () => PnpmCommand,
  nodeVersion: string,
): Promise<void> {
  if (!nodeVersion.startsWith(`${REQUIRED_NODE_MAJOR}.`)) {
    fail(
      "RUNTIME_BUILD_PREREQUISITE_MISMATCH",
      `Node ${REQUIRED_NODE_MAJOR} is required, got ${nodeVersion}`,
    );
  }
  const pnpm = resolvePnpm();
  const pnpmVersion = await runCommand(
    pnpm.command,
    [...pnpm.args, "--version"],
    sourceRoot,
    "RUNTIME_BUILD_PREREQUISITE_MISMATCH",
  );
  if (pnpmVersion !== REQUIRED_PNPM) {
    fail(
      "RUNTIME_BUILD_PREREQUISITE_MISMATCH",
      `pnpm ${REQUIRED_PNPM} is required, got ${pnpmVersion}`,
    );
  }
}

async function applyPinnedSourcePatch(
  sourceRoot: string,
  repositoryRoot: string,
  runCommand: CommandRunner,
): Promise<string> {
  const patchPath = join(repositoryRoot, SOURCE_PATCH_RELATIVE);
  const patchContent = await readFile(patchPath, "utf8").catch(() =>
    fail(
      "RUNTIME_SOURCE_PATCH_MISSING",
      `runtime source patch is missing: ${patchPath}`,
    ),
  );
  const digest = sha256(patchContent);
  if (digest !== EXPECTED_SOURCE_PATCH_SHA256) {
    fail(
      "RUNTIME_SOURCE_PATCH_MISMATCH",
      `runtime source patch must hash to ${EXPECTED_SOURCE_PATCH_SHA256}, got ${digest}`,
    );
  }
  await runCommand(
    "git",
    ["apply", "--check", patchPath],
    sourceRoot,
    "RUNTIME_SOURCE_PATCH_INVALID",
  );
  await runCommand(
    "git",
    ["apply", patchPath],
    sourceRoot,
    "RUNTIME_SOURCE_PATCH_INVALID",
  );
  return patchPath;
}

async function restorePinnedSourcePatch(
  sourceRoot: string,
  patchPath: string,
  runCommand: CommandRunner,
): Promise<void> {
  await runCommand(
    "git",
    ["apply", "--reverse", patchPath],
    sourceRoot,
    "RUNTIME_SOURCE_PATCH_RESTORE_FAILED",
  );
  await verifyCleanWorktree(sourceRoot, runCommand);
}

async function runPnpm(
  sourceRoot: string,
  args: readonly string[],
  runCommand: CommandRunner,
  resolvePnpm: () => PnpmCommand,
  code?: string,
): Promise<string> {
  const pnpm = resolvePnpm();
  return runCommand(pnpm.command, [...pnpm.args, ...args], sourceRoot, code);
}

async function stageWindowsRuntime(
  sourceRoot: string,
  out: string,
): Promise<void> {
  const sourceDirectory = join(sourceRoot, "dist-exe");
  const expectedFiles = new Set([WINDOWS_RUNTIME, WINDOWS_RG]);
  const closure = await readdir(sourceDirectory).catch(() => undefined);
  if (closure === undefined) {
    fail(
      "RUNTIME_BUILD_CLOSURE_MISMATCH",
      `upstream build did not produce ${sourceDirectory}`,
    );
  }

  const unexpected = closure.filter(
    (name) =>
      name.startsWith("deepseek-harness-sdk-runtime-win-x64") &&
      !expectedFiles.has(name),
  );
  if (unexpected.length > 0) {
    fail(
      "RUNTIME_BUILD_CLOSURE_MISMATCH",
      `upstream build produced unexpected Windows sidecars: ${unexpected.join(", ")}`,
    );
  }

  const outputDirectory = join(out, "bin");
  await mkdir(outputDirectory, { recursive: true });
  for (const name of expectedFiles) {
    const source = join(sourceDirectory, name);
    try {
      const metadata = await stat(source);
      if (!metadata.isFile()) {
        throw new Error("not a file");
      }
    } catch {
      fail(
        "RUNTIME_BUILD_CLOSURE_MISMATCH",
        `upstream build did not produce ${source}`,
      );
    }
    await copyFile(source, join(outputDirectory, name));
  }
}

function runtimeFromLock(lock: RuntimeLockV1, out: string): VerifiedRuntime {
  const spec = lock.platforms[WINDOWS_PLATFORM];
  return {
    platform: WINDOWS_PLATFORM,
    root: out,
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

async function generateSbom(
  out: string,
  lockPath: string,
  baseRepositoryRoot: string,
): Promise<void> {
  await run(
    process.execPath,
    [
      "--experimental-strip-types",
      join(baseRepositoryRoot, "scripts", "runtime", "generate-sbom.ts"),
      "--lock",
      lockPath,
      "--out",
      join(out, "sbom", "runtime.cdx.json"),
    ],
    baseRepositoryRoot,
  );
}

export async function buildFromSource(
  options: BuildFromSourceOptions,
  overrides: BuildFromSourceOverrides = {},
): Promise<VerifiedRuntime> {
  const sourceRoot = resolve(options.sourceRoot);
  const out = resolve(options.out);
  const pin = overrides.pin ?? defaultPin;
  const runCommand = overrides.runCommand ?? run;
  const resolvePnpm =
    overrides.resolvePnpmCommand ??
    (() =>
      resolvePnpmCommandForEnvironment(
        overrides.environment ?? process.env,
        overrides.platform ?? process.platform,
      ));
  const lockPath = resolve(overrides.lockPath ?? runtimeLockPath);
  const lockLoader = overrides.loadRuntimeLock ?? loadRuntimeLock;
  const runtimeVerifier = overrides.verifyRuntime ?? verifyRuntime;
  const nodeVersion = overrides.nodeVersion ?? process.versions.node;
  const baseRepositoryRoot = overrides.repositoryRoot ?? repositoryRoot;
  const writeSbom =
    overrides.generateSbom ??
    ((runtimeRoot: string, pinnedLockPath: string) =>
      generateSbom(runtimeRoot, pinnedLockPath, baseRepositoryRoot));

  if (options.platform !== WINDOWS_PLATFORM) {
    fail(
      "RUNTIME_PLATFORM_NOT_BUILT",
      `source builds currently support only ${WINDOWS_PLATFORM}`,
    );
  }

  await verifyPinnedSourceCheckout(sourceRoot, pin, { runCommand });
  await verifyToolchain(sourceRoot, runCommand, resolvePnpm, nodeVersion);

  const lock = await lockLoader(lockPath);
  if (lock.licenseResult.spdx !== pin.license) {
    fail(
      "RUNTIME_LOCK_LICENSE_MISMATCH",
      `runtime lock must declare ${pin.license}, got ${lock.licenseResult.spdx}`,
    );
  }

  const patchPath =
    pin.commit === DSH_COMMIT
      ? await applyPinnedSourcePatch(sourceRoot, baseRepositoryRoot, runCommand)
      : undefined;
  try {
    await runPnpm(
      sourceRoot,
      ["run", "verify-runtime-closure"],
      runCommand,
      resolvePnpm,
    );
    await runPnpm(
      sourceRoot,
      [
        "exec",
        "tsx",
        "scripts/build-exe-for-python-sdk.ts",
        "--targets",
        WINDOWS_TARGET,
      ],
      runCommand,
      resolvePnpm,
    );
    await stageWindowsRuntime(sourceRoot, out);
  } finally {
    if (patchPath) {
      await restorePinnedSourcePatch(sourceRoot, patchPath, runCommand);
    }
  }
  await writeSbom(out, lockPath);
  const verifiedLock = overrides.loadRuntimeLock
    ? lock
    : await persistBuiltRuntimeHashes(lockPath, out, options.platform);
  const runtime = runtimeFromLock(verifiedLock, out);
  return runtimeVerifier(runtime);
}

function usage(): string {
  return [
    "Usage: node --experimental-strip-types scripts/runtime/build-from-source.ts [flags]",
    "",
    "  --source-root <path>  Pinned DSH source checkout.",
    "  --platform <key>      Only win32-x64 is source-built in this release.",
    "  --out <path>          Output runtime root.",
    "  --help                Show this help.",
    "",
    `Build prerequisites: Node ${REQUIRED_NODE_MAJOR} and pnpm ${REQUIRED_PNPM}.`,
    `The source must be pinned to ${DSH_TAG} at ${DSH_COMMIT}.`,
    `The source pnpm lock must hash to ${EXPECTED_SOURCE_LOCK_SHA256}.`,
  ].join("\n");
}

if (import.meta.main) {
  const values = parseArgs({
    args: process.argv.slice(2),
    options: {
      "source-root": { type: "string" },
      platform: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  }).values;

  if (values.help) {
    console.log(usage());
  } else {
    const platform = values.platform ?? currentPlatform();
    if (
      !values["source-root"] ||
      !values.out ||
      !["win32-x64", "linux-x64", "linux-arm64", "darwin-arm64"].includes(
        platform,
      )
    ) {
      console.error(usage());
      process.exitCode = 1;
    } else {
      buildFromSource({
        sourceRoot: values["source-root"],
        platform: platform as PlatformKey,
        out: values.out,
      })
        .then((runtime) => console.log(`runtime built: ${runtime.platform}`))
        .catch((error: unknown) => {
          const code =
            error instanceof RuntimeBuildError ? `${error.code}: ` : "";
          console.error(
            `${code}${error instanceof Error ? error.message : String(error)}`,
          );
          process.exitCode = 1;
        });
    }
  }
}
