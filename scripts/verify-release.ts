import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

type PlatformKey = "win32-x64" | "linux-x64" | "linux-arm64" | "darwin-arm64";

type ReleaseFailure = {
  code: string;
  artifact?: string;
};

export type ReleaseReport = {
  supported: PlatformKey[];
  preview: PlatformKey[];
  failures: ReleaseFailure[];
};

const RELEASE_PLATFORM: PlatformKey = "win32-x64";
const REQUIRED_DOCS = [
  "platform-support.md",
  "security-model.md",
  "runtime-provenance.md",
  "recovery.md",
  "capability-runtime-migration.md",
] as const;

export async function verifyRelease(root: string): Promise<ReleaseReport> {
  const failures: ReleaseFailure[] = [];
  const lock = await readJson(
    join(root, "runtime-lock", "dsh-runtime.json"),
    failures,
  );
  const manifest = await readJson(join(root, "manifest.json"), failures);

  const supported = supportedPlatforms(lock, failures);
  const preview: PlatformKey[] = [];
  if (supported.length !== 1 || supported[0] !== RELEASE_PLATFORM) {
    failures.push({ code: "RELEASE_PLATFORM_MATRIX_INVALID" });
  }
  if (!manifestMatchesReleasePlatform(manifest)) {
    failures.push({
      code: "RELEASE_MANIFEST_PLATFORM_INVALID",
      artifact: "manifest.json",
    });
  }

  for (const document of REQUIRED_DOCS) {
    try {
      await access(join(root, "docs", document));
    } catch {
      failures.push({ code: "MISSING_RELEASE_DOC", artifact: document });
    }
  }

  await verifyZip(root, failures);
  return { supported, preview, failures };
}

function supportedPlatforms(
  lock: unknown,
  failures: ReleaseFailure[],
): PlatformKey[] {
  const record = asRecord(lock);
  // A multi-release fixture catalog resolves the production release from
  // the pinned first entry; remaining entries are test-only fixtures.
  const releases = Array.isArray(record?.releases)
    ? asRecord(record.releases[0])
    : undefined;
  const platforms = asRecord(releases?.platforms ?? record?.platforms);
  if (!asRecord(platforms)) {
    failures.push({
      code: "RUNTIME_LOCK_INVALID",
      artifact: "runtime-lock/dsh-runtime.json",
    });
    return [];
  }
  return (Object.entries(platforms) as [PlatformKey, unknown][])
    .filter(
      ([, value]) =>
        asRecord(asRecord(value)?.artifactState)?.status === "built",
    )
    .map(([platform]) => platform);
}

function manifestMatchesReleasePlatform(manifest: unknown): boolean {
  const record = asRecord(manifest);
  const platforms = asRecord(record?.host)?.platforms;
  const executables = asRecord(asRecord(record?.sidecar)?.executable);
  return (
    Array.isArray(platforms) &&
    platforms.length === 1 &&
    platforms[0] === RELEASE_PLATFORM &&
    Object.keys(executables ?? {}).length === 1 &&
    typeof executables?.[RELEASE_PLATFORM] === "string"
  );
}

async function verifyZip(
  root: string,
  failures: ReleaseFailure[],
): Promise<void> {
  const zipName = "dsh-coding-workspace-0.1.0-win32-x64.zip";
  const zip = join(root, "dist", zipName);
  const checksum = `${zip}.sha256`;
  let content: Buffer;
  try {
    content = await readFile(zip);
  } catch {
    failures.push({ code: "RELEASE_ZIP_MISSING", artifact: zipName });
    return;
  }

  const actual = createHash("sha256").update(content).digest("hex");
  try {
    const persisted = (await readFile(checksum, "utf8")).trim().split(/\s+/)[0];
    if (persisted !== actual) {
      failures.push({
        code: "RELEASE_ZIP_CHECKSUM_MISMATCH",
        artifact: `${zipName}.sha256`,
      });
    }
  } catch {
    failures.push({
      code: "RELEASE_ZIP_CHECKSUM_MISSING",
      artifact: `${zipName}.sha256`,
    });
  }

  const listing = spawnSync("tar", ["-tf", zip], { encoding: "utf8" });
  if (listing.status !== 0) {
    failures.push({ code: "RELEASE_ZIP_UNREADABLE", artifact: zipName });
    return;
  }
  const entries = new Set(listing.stdout.split(/\r?\n/).filter(Boolean));
  for (const entry of [
    "manifest.json",
    "runtime-lock.json",
    "support-results.json",
    "licenses/runtime-MIT.txt",
    "licenses/runtime-THIRD_PARTY_NOTICES.md",
    "licenses/aio-dsh-supervisor-Apache-2.0.txt",
    "bin/win32-x64/aio-dsh-supervisor.exe",
    "host/aio-dsh-host.mjs",
    "host/cordis.patch.yml",
    "bin/deepseek-harness-sdk-runtime-win-x64.exe",
    "bin/deepseek-harness-sdk-runtime-win-x64-rg.exe",
    "sbom/runtime.cdx.json",
  ]) {
    if (!entries.has(entry)) {
      failures.push({ code: "RELEASE_ZIP_ENTRY_MISSING", artifact: entry });
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

async function readJson(
  path: string,
  failures: ReleaseFailure[],
): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    failures.push({ code: "RELEASE_METADATA_UNREADABLE", artifact: path });
    return undefined;
  }
}

if (import.meta.main) {
  const root = process.cwd();
  const report = await verifyRelease(root);
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length > 0) process.exitCode = 1;
}
