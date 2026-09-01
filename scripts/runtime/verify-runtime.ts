import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  DSH_COMMIT,
  DSH_CONTRACT_HASH,
  DSH_TAG,
  type RuntimeArtifactState,
  type PlatformKey,
  type RuntimeFile,
  type RuntimeSource,
  type RuntimeToolchain,
  type VerifiedRuntime,
  currentPlatform,
  loadRuntimeLock,
} from "./resolve-runtime.ts";

const supportedLicenses = new Set(["MIT", "Apache-2.0"]);

const requiredHelpers: Record<PlatformKey, readonly string[]> = {
  "win32-x64": ["deepseek-harness-sdk-runtime-win-x64-rg.exe"],
  "linux-x64": ["deepseek-harness-sdk-runtime-linux-x64-rg"],
  "linux-arm64": ["deepseek-harness-sdk-runtime-linux-arm64-rg"],
  "darwin-arm64": [
    "deepseek-harness-sdk-runtime-macos-arm64-rg",
    "deepseek-harness-sdk-runtime-macos-arm64-spawn-helper",
  ],
};

const expectedTargets: Record<PlatformKey, string> = {
  "win32-x64": "node24-win-x64",
  "linux-x64": "node24-linux-x64",
  "linux-arm64": "node24-linux-arm64",
  "darwin-arm64": "node24-macos-arm64",
};

class RuntimeVerificationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "RuntimeVerificationError";
  }
}

function fail(code: string, message: string): never {
  throw new RuntimeVerificationError(code, message);
}

export async function verifyRuntime(
  runtime: VerifiedRuntime
): Promise<VerifiedRuntime> {
  verifySource(runtime.source);
  verifyPlatform(runtime);
  verifyLicense(runtime.license);
  verifyContract(runtime.contractHash);
  verifyToolchain(runtime.toolchain);
  verifyArtifactState(runtime);
  await verifyFiles(runtime);
  verifyClosure(runtime);
  return runtime;
}

function verifySource(source: RuntimeSource): void {
  if (source.kind === "project-built-from-official-source") {
    if (source.tag !== DSH_TAG || source.commit !== DSH_COMMIT) {
      fail(
        "RUNTIME_MOVING_REF",
        `DSH source must be pinned to ${DSH_TAG} at ${DSH_COMMIT}`
      );
    }
    return;
  }

  const url = new URL(source.url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "pypi.org" ||
    url.pathname.includes("/actions/runs/")
  ) {
    fail(
      "RUNTIME_TEMPORARY_ACTIONS_ARTIFACT",
      `official wheel URL is not a persistent PyPI artifact: ${source.url}`
    );
  }
  if (!/^[0-9a-f]{64}$/.test(source.sha256)) {
    fail("RUNTIME_CHECKSUM_MISMATCH", "official wheel SHA-256 is invalid");
  }
}

function verifyPlatform(runtime: VerifiedRuntime): void {
  if (runtime.nodePkgTarget !== expectedTargets[runtime.platform]) {
    fail(
      "RUNTIME_WRONG_ARCH",
      `${runtime.platform} requires ${expectedTargets[runtime.platform]}, got ${runtime.nodePkgTarget}`
    );
  }
}

function verifyLicense(license: unknown): void {
  const spdx =
    typeof license === "string"
      ? license
      : typeof license === "object" &&
          license !== null &&
          "spdx" in license &&
          typeof (license as { spdx: unknown }).spdx === "string"
        ? (license as { spdx: string }).spdx
        : undefined;
  if (spdx === undefined || !supportedLicenses.has(spdx)) {
    fail(
      "RUNTIME_UNSUPPORTED_LICENSE",
      `runtime license must be MIT or Apache-2.0, got ${JSON.stringify(license)}`
    );
  }
}

function verifyContract(contractHash: string): void {
  if (contractHash !== DSH_CONTRACT_HASH) {
    fail(
      "RUNTIME_CONTRACT_MISMATCH",
      `contract hash must be ${DSH_CONTRACT_HASH}, got ${contractHash}`
    );
  }
}

function verifyToolchain(toolchain: RuntimeToolchain): void {
  if (
    toolchain.node !== "24" ||
    toolchain.pnpm !== "11.7.0" ||
    toolchain.python !== "3.10" ||
    toolchain.rust !== "1.89.0"
  ) {
    fail("RUNTIME_TOOLCHAIN_MISMATCH", "runtime toolchain is not pinned");
  }
}

function verifyArtifactState(runtime: VerifiedRuntime): void {
  if (runtime.artifactState.status === "not-built") {
    fail(
      "RUNTIME_PENDING_NATIVE_BUILD",
      `${runtime.platform} runtime is not built: ${runtime.artifactState.reason}`
    );
  }
  if (runtime.files.length === 0) {
    fail(
      "RUNTIME_ARTIFACT_STATE_MISMATCH",
      `${runtime.platform} lock is marked built but has no files`
    );
  }
}

async function verifyFiles(runtime: VerifiedRuntime): Promise<void> {
  for (const file of runtime.files) {
    const absolutePath = resolve(runtime.root, file.path);
    const relativePath = relative(runtime.root, absolutePath);
    if (
      isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith("..")
    ) {
      fail(
        "RUNTIME_PATH_TRAVERSAL",
        `runtime file escapes root: ${file.path}`
      );
    }
    const metadata = await stat(absolutePath).catch(() => undefined);
    if (!metadata?.isFile()) {
      fail("RUNTIME_MISSING_HELPER", `runtime file is missing: ${file.path}`);
    }
    const content = await readFile(absolutePath);
    const actual = createHash("sha256").update(content).digest("hex");
    if (actual !== file.sha256) {
      fail(
        "RUNTIME_CHECKSUM_MISMATCH",
        `SHA-256 mismatch for ${file.path}: expected ${file.sha256}, got ${actual}`
      );
    }
  }
}

function verifyClosure(runtime: VerifiedRuntime): void {
  const files = new Map(runtime.files.map((file) => [file.path, file]));
  for (const path of runtime.runtimeClosure) {
    if (!files.has(path)) {
      fail("RUNTIME_MISSING_HELPER", `runtime closure is missing ${path}`);
    }
  }
  for (const helper of requiredHelpers[runtime.platform]) {
    const present = [...files.keys()].some((path) => path.endsWith(helper));
    if (!present) {
      fail(
        "RUNTIME_MISSING_HELPER",
        `${runtime.platform} runtime is missing helper ${helper}`
      );
    }
  }
}

type SinglePlatformLock = {
  schemaVersion: number;
  platform: PlatformKey;
  source: RuntimeSource;
  artifactState: RuntimeArtifactState;
  nodePkgTarget: string;
  files: RuntimeFile[];
  runtimeClosure: string[];
  license: string;
  contractHash: string;
  toolchain: RuntimeToolchain;
};

async function runtimeFromLock(
  path: string,
  root: string,
  platform: PlatformKey
): Promise<VerifiedRuntime> {
  const payload = JSON.parse(await readFile(path, "utf8")) as
    | ReturnType<typeof singlePlatformLock>
    | undefined;
  if (payload === undefined) {
    throw new Error(`RUNTIME_LOCK_INVALID: ${path}`);
  }
  if ("platforms" in payload) {
    const lock = await loadRuntimeLock(path);
    const spec = lock.platforms[platform];
    if (!spec) {
      throw new Error(`RUNTIME_PLATFORM_UNSUPPORTED: ${platform}`);
    }
    return {
      platform,
      root,
      source: lock.source,
      artifactState: spec.artifactState,
      files: spec.files,
      license: lock.licenseResult.spdx,
      contractHash: lock.contractHash,
      runtimeClosure: spec.runtimeClosure,
      nodePkgTarget: spec.nodePkgTarget,
      toolchain: lock.toolchain,
    };
  }
  return {
    platform: payload.platform,
    root,
    source: payload.source,
    artifactState: payload.artifactState,
    files: payload.files ?? [],
    license: payload.license,
    contractHash: payload.contractHash,
    runtimeClosure: payload.runtimeClosure ?? [],
    nodePkgTarget: payload.nodePkgTarget,
    toolchain: payload.toolchain,
  };
}

function singlePlatformLock(): unknown {
  return {} as SinglePlatformLock;
}

function usage(): string {
  return [
    "Usage: bun scripts/runtime/verify-runtime.ts --lock <path> --root <path> [--platform <key>] [--offline]",
    "",
    "  --lock <path>     Runtime lock JSON.",
    "  --root <path>     Runtime artifact root.",
    "  --platform <key>  Select a platform from a multi-platform lock.",
    "  --offline         Disable network access; verification is local.",
    "  --help            Show this help.",
  ].join("\n");
}

if (import.meta.main) {
  const values = parseArgs({
    args: process.argv.slice(2),
    options: {
      lock: { type: "string" },
      root: { type: "string" },
      platform: { type: "string" },
      offline: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  }).values;

  if (values.help) {
    console.log(usage());
  } else if (!values.lock || !values.root) {
    console.error(usage());
    process.exitCode = 1;
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
    if (platform === undefined) {
      console.error(`RUNTIME_PLATFORM_UNSUPPORTED: ${values.platform}`);
      process.exitCode = 1;
    } else {
      try {
        const runtime = await runtimeFromLock(
          values.lock,
          resolve(values.root),
          platform
        );
        await verifyRuntime(runtime);
        console.log(`runtime verified: ${runtime.platform}`);
      } catch (error) {
        if (error instanceof RuntimeVerificationError) {
          console.error(`${error.code}: ${error.message}`);
        } else {
          console.error(error instanceof Error ? error.message : error);
        }
        process.exitCode = 1;
      }
    }
  }
}
