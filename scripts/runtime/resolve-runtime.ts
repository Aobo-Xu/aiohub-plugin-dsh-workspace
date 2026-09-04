import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export type PlatformKey =
  "win32-x64" | "linux-x64" | "linux-arm64" | "darwin-arm64";

export type RuntimeSource = {
  kind: "official-wheel";
  url: string;
  sha256: string;
};

export type RuntimeFile = {
  path: string;
  sha256: string;
  executable: boolean;
};

export type RuntimeToolchain = {
  node: "not-applicable";
  pnpm: "not-applicable";
  python: "3.10";
  rust: "not-applicable";
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

export type OfficialWheelStatus = {
  status: "available";
  platform: "win32-x64";
  url: string;
  sha256: string;
};

export type RuntimeLockV1 = {
  schemaVersion: 1;
  version: string;
  tag: string;
  commit: string;
  publishedAt: string;
  source: RuntimeSource;
  officialWheel: {
    status: "available";
    distribution: "deepseek-harness-runtime-bin";
    filename: string;
    platform: "win32-x64";
    url: string;
    sha256: string;
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
  version: string;
  platform: PlatformKey;
  root: string;
  source: RuntimeSource;
  sourcePatches?: readonly {
    path: string;
    sha256: string;
    reason: string;
  }[];
  artifactState: RuntimeArtifactState;
  files: readonly RuntimeFile[];
  license: string;
  contractHash: string;
  runtimeClosure: readonly string[];
  cyclonedxPath: string;
  nodePkgTarget: string;
  toolchain: RuntimeToolchain;
};

export const DSH_CONTRACT_HASH =
  "96af8af6cdb538da2cd13c53eb4dd640f0ca233aab68b209d82fc744e01da519" as const;

const repositoryRoot = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);
const lockPath = join(
  repositoryRoot,
  "runtime-lock",
  "dsh-runtime.json",
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
    typeof lock.version !== "string" ||
    lock.version.length === 0 ||
    lock.tag !== `dsh-v${lock.version}` ||
    !/^[0-9a-f]{40}$/.test(lock.commit) ||
    lock.contractHash !== DSH_CONTRACT_HASH ||
    lock.source?.kind !== "official-wheel" ||
    lock.source.url !== lock.officialWheel?.url ||
    lock.source.sha256 !== lock.officialWheel?.sha256 ||
    lock.officialWheel?.status !== "available" ||
    lock.officialWheel.platform !== "win32-x64" ||
    lock.officialWheel.filename.length === 0
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
  platform: PlatformKey,
): OfficialWheelStatus {
  if (platform !== "win32-x64") {
    throw new Error(`RUNTIME_OFFICIAL_WHEEL_UNAVAILABLE: ${platform}`);
  }
  return {
    status: "available",
    platform,
    url: lock.source.url,
    sha256: lock.source.sha256,
  };
}

export async function resolveRuntime(
  platform: PlatformKey,
  options: { root?: string } = {},
): Promise<VerifiedRuntime> {
  const lock = await loadRuntimeLock();
  const spec = lock.platforms[platform];
  if (!spec) {
    throw new Error(`RUNTIME_PLATFORM_UNSUPPORTED: ${platform}`);
  }
  return {
    version: lock.version,
    platform,
    root: resolve(
      options.root ?? join(repositoryRoot, ".artifacts", "runtime"),
    ),
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
    "Usage: node --experimental-strip-types scripts/runtime/resolve-runtime.ts [flags]",
    "",
    "  --platform <key>  win32-x64, linux-x64, linux-arm64, or darwin-arm64.",
    "                   Defaults to the current host platform.",
    "  --out <path>     Runtime root used for source-built artifacts.",
    "  --offline        Do not probe PyPI for an official wheel.",
    "  --help           Show this help.",
    "",
    "Windows x64 resolves to the official PyPI wheel pinned by runtime-lock/dsh-runtime.json.",
    "Acquisition verifies the wheel SHA-256 before extracting the audited closure.",
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
