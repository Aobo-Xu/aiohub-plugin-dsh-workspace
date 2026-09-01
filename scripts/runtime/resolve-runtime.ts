import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export type PlatformKey =
  | "win32-x64"
  | "linux-x64"
  | "linux-arm64"
  | "darwin-arm64";

export type RuntimeSource =
  | {
      kind: "official-wheel";
      url: string;
      sha256: string;
    }
  | {
      kind: "project-built-from-official-source";
      tag: "dsh-v0.1.2-alpha.3";
      commit: "dd6322d604e00eec1ba5e0c8541159906a21094a";
    };

export type RuntimeFile = {
  path: string;
  sha256: string;
  executable: boolean;
};

export type RuntimeToolchain = {
  node: "24";
  pnpm: "11.7.0";
  python: "3.10";
  rust: "1.89.0";
};

export type RuntimeArtifactState =
  | {
      status: "not-built";
      reason: "native-runner-required";
    }
  | {
      status: "built";
    };

export type RuntimePlatformSpec = {
  platform: PlatformKey;
  arch: "x64" | "arm64";
  artifactState: RuntimeArtifactState;
  nodePkgTarget: string;
  pythonTarget: string;
  osFloor: {
    kind: "windows" | "glibc" | "macos";
    version: string;
  };
  runtimeClosure: readonly string[];
  files: readonly RuntimeFile[];
};

export type OfficialWheelStatus =
  | {
      status: "unavailable";
      reason: "not-published-for-0.1.2a3";
    }
  | {
      status: "available";
      platform: PlatformKey;
      url: string;
      sha256: string;
    };

export type RuntimeLockV1 = {
  schemaVersion: 1;
  version: "0.1.2-alpha.3";
  tag: "dsh-v0.1.2-alpha.3";
  commit: "dd6322d604e00eec1ba5e0c8541159906a21094a";
  publishedAt: "2026-08-31T16:03:39Z";
  source: RuntimeSource;
  officialWheel: {
    status: "unavailable";
    distributions: readonly string[];
  };
  license: "MIT";
  licenseResult: {
    spdx: "MIT";
    source: "upstream-package";
  };
  cyclonedxPath: "sbom/runtime.cdx.json";
  profileVersion: "dsh-runtime-profile-v1";
  contractHash: "96af8af6cdb538da2cd13c53eb4dd640f0ca233aab68b209d82fc744e01da519";
  aioSemverRange: ">=0.7.0-alpha.4";
  toolchain: RuntimeToolchain;
  platforms: Record<PlatformKey, RuntimePlatformSpec>;
};

export type VerifiedRuntime = {
  platform: PlatformKey;
  root: string;
  source: RuntimeSource;
  artifactState: RuntimeArtifactState;
  files: readonly RuntimeFile[];
  license: string;
  contractHash: string;
  runtimeClosure: readonly string[];
  nodePkgTarget: string;
  toolchain: RuntimeToolchain;
};

export const DSH_TAG = "dsh-v0.1.2-alpha.3" as const;
export const DSH_COMMIT =
  "dd6322d604e00eec1ba5e0c8541159906a21094a" as const;
export const DSH_VERSION = "0.1.2-alpha.3" as const;
export const DSH_CONTRACT_HASH =
  "96af8af6cdb538da2cd13c53eb4dd640f0ca233aab68b209d82fc744e01da519" as const;

const repositoryRoot = dirname(
  dirname(dirname(fileURLToPath(import.meta.url)))
);
const lockPath = join(
  repositoryRoot,
  "runtime-lock",
  "dsh-v0.1.2-alpha.3.json"
);

const platformKeys = [
  "win32-x64",
  "linux-x64",
  "linux-arm64",
  "darwin-arm64",
] as const;

export function isPlatformKey(value: string): value is PlatformKey {
  return (platformKeys as readonly string[]).includes(value);
}

export function currentPlatform(): PlatformKey {
  const key = `${process.platform}-${process.arch}`;
  if (!isPlatformKey(key)) {
    throw new Error(`RUNTIME_PLATFORM_UNSUPPORTED: ${key}`);
  }
  return key;
}

export async function loadRuntimeLock(path = lockPath): Promise<RuntimeLockV1> {
  const payload = JSON.parse(await readFile(path, "utf8"));
  return assertRuntimeLock(payload, path);
}

function assertRuntimeLock(payload: unknown, path: string): RuntimeLockV1 {
  const lock = payload as RuntimeLockV1;
  if (
    lock.schemaVersion !== 1 ||
    lock.tag !== DSH_TAG ||
    lock.commit !== DSH_COMMIT ||
    lock.version !== DSH_VERSION ||
    lock.contractHash !== DSH_CONTRACT_HASH ||
    lock.source?.kind !== "project-built-from-official-source" ||
    lock.source.tag !== DSH_TAG ||
    lock.source.commit !== DSH_COMMIT
  ) {
    throw new Error(`RUNTIME_LOCK_INVALID: ${path}`);
  }
  for (const key of platformKeys) {
    const platform = lock.platforms?.[key];
    const artifactState = platform?.artifactState;
    const stateIsValid =
      (artifactState?.status === "not-built" &&
        artifactState.reason === "native-runner-required") ||
      artifactState?.status === "built";
    if (
      !platform ||
      platform.platform !== key ||
      !stateIsValid ||
      !Array.isArray(platform.runtimeClosure) ||
      !Array.isArray(platform.files) ||
      (artifactState?.status === "not-built" && platform.files.length !== 0) ||
      (artifactState?.status === "built" && platform.files.length === 0)
    ) {
      throw new Error(`RUNTIME_LOCK_INVALID: missing ${key}`);
    }
  }
  return lock;
}

export function officialWheelStatus(
  lock: RuntimeLockV1,
  platform: PlatformKey
): OfficialWheelStatus {
  if (lock.source.kind === "official-wheel") {
    return {
      status: "available",
      platform,
      url: lock.source.url,
      sha256: lock.source.sha256,
    };
  }
  return {
    status: "unavailable",
    reason: "not-published-for-0.1.2a3",
  };
}

export async function resolveRuntime(
  platform: PlatformKey,
  options: { root?: string } = {}
): Promise<VerifiedRuntime> {
  const lock = await loadRuntimeLock();
  const spec = lock.platforms[platform];
  if (!spec) {
    throw new Error(`RUNTIME_PLATFORM_UNSUPPORTED: ${platform}`);
  }
  return {
    platform,
    root: resolve(options.root ?? join(repositoryRoot, ".artifacts", "runtime")),
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

function usage(): string {
  return [
    "Usage: bun scripts/runtime/resolve-runtime.ts [flags]",
    "",
    "  --platform <key>  win32-x64, linux-x64, linux-arm64, or darwin-arm64.",
    "                   Defaults to the current host platform.",
    "  --out <path>     Runtime root used for source-built artifacts.",
    "  --offline        Do not probe PyPI for an official wheel.",
    "  --help           Show this help.",
    "",
    "The alpha.3 official wheel is unavailable for all platforms.",
    "Resolution therefore selects project-built-from-official-source.",
  ].join("\n");
}

if (import.meta.main) {
  const values = parseArgs({
    args: process.argv.slice(2),
    options: {
      platform: { type: "string" },
      out: { type: "string" },
      offline: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  }).values;

  if (values.help) {
    console.log(usage());
  } else {
    const platform =
      values.platform === undefined
        ? currentPlatform()
        : isPlatformKey(values.platform)
          ? values.platform
          : undefined;
    if (platform === undefined) {
      console.error(`RUNTIME_PLATFORM_UNSUPPORTED: ${values.platform}`);
      process.exitCode = 1;
    } else {
      const runtime = await resolveRuntime(platform, { root: values.out });
      console.log(JSON.stringify(runtime, null, 2));
    }
  }
}
