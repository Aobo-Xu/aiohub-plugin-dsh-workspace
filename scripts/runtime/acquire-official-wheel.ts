import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { generateSbom } from "./generate-sbom.ts";

export type WheelExtractor = (
  wheelPath: string,
  destination: string,
) => Promise<void>;

type AcquireOptions = { lockPath: string; out: string };
type AcquireDependencies = {
  download?: (url: string) => Promise<Buffer>;
  extract?: WheelExtractor;
  generateSbom?: (lockPath: string, out: string) => Promise<void>;
};

const WHEEL_RUNTIME_ROOT = join("deepseek_harness_runtime", "runtime");
export async function acquireOfficialWheel(
  options: AcquireOptions,
  dependencies: AcquireDependencies = {},
): Promise<{ platform: "win32-x64"; root: string }> {
  const lock = JSON.parse(await readFile(options.lockPath, "utf8")) as {
    source?: { kind?: string; url?: string; sha256?: string };
    cyclonedxPath?: string;
    platforms?: { "win32-x64"?: { files?: { path: string; sha256: string }[] } };
  };
  if (
    lock.source?.kind !== "official-wheel" ||
    typeof lock.source.url !== "string" ||
    !/^[0-9a-f]{64}$/.test(lock.source.sha256 ?? "")
  ) {
    throw new Error("RUNTIME_WHEEL_LOCK_INVALID");
  }

  const root = resolve(options.out);
  const scratch = await mkdtemp(join(tmpdir(), "dsh-runtime-wheel-"));
  try {
    const bytes = await (dependencies.download ?? download)(lock.source.url);
    const actualWheelHash = sha256(bytes);
    if (actualWheelHash !== lock.source.sha256) {
      throw new Error(
        `RUNTIME_WHEEL_CHECKSUM_MISMATCH: expected ${lock.source.sha256}, got ${actualWheelHash}`,
      );
    }

    const wheelPath = join(scratch, "runtime.whl");
    const extracted = join(scratch, "extracted");
    await writeFile(wheelPath, bytes);
    await mkdir(extracted, { recursive: true });
    await (dependencies.extract ?? extractWithPython)(wheelPath, extracted);

    const distInfo = (await readdir(extracted, { withFileTypes: true })).find(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith("deepseek_harness_runtime_bin-") &&
        entry.name.endsWith(".dist-info"),
    )?.name;
    if (!distInfo) {
      throw new Error("RUNTIME_WHEEL_METADATA_MISSING");
    }
    const copies = [
      [join(WHEEL_RUNTIME_ROOT, "deepseek-harness-sdk-runtime-win-x64.exe"), "bin/deepseek-harness-sdk-runtime-win-x64.exe"],
      [join(WHEEL_RUNTIME_ROOT, "deepseek-harness-sdk-runtime-win-x64-rg.exe"), "bin/deepseek-harness-sdk-runtime-win-x64-rg.exe"],
      [join(distInfo, "licenses", "LICENSE"), "licenses/runtime-MIT.txt"],
      [join(distInfo, "licenses", "THIRD_PARTY_NOTICES.md"), "licenses/runtime-THIRD_PARTY_NOTICES.md"],
    ] as const;

    await rm(root, { recursive: true, force: true });
    for (const [source, destination] of copies) {
      const target = join(root, ...destination.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(extracted, source), target).catch(() => {
        throw new Error(`RUNTIME_WHEEL_ENTRY_MISSING: ${source}`);
      });
    }
    const sbomPath = join(root, ...(lock.cyclonedxPath ?? "sbom/runtime.cdx.json").split("/"));
    await (dependencies.generateSbom ?? generateSbom)(options.lockPath, sbomPath);

    for (const file of lock.platforms?.["win32-x64"]?.files ?? []) {
      const actual = sha256(await readFile(join(root, ...file.path.split("/"))));
      if (actual !== file.sha256) {
        throw new Error(
          `RUNTIME_CHECKSUM_MISMATCH: ${file.path} expected ${file.sha256}, got ${actual}`,
        );
      }
    }
    return { platform: "win32-x64", root };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function download(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "files.pythonhosted.org"
  ) {
    throw new Error(`RUNTIME_WHEEL_URL_INVALID: ${url}`);
  }
  const response = await fetch(parsed);
  if (!response.ok) {
    throw new Error(`RUNTIME_WHEEL_DOWNLOAD_FAILED: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function extractWithPython(wheelPath: string, destination: string): Promise<void> {
  const result = spawnSync(
    "python",
    ["-m", "zipfile", "-e", wheelPath, destination],
    { encoding: "utf8", timeout: 120_000 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `RUNTIME_WHEEL_EXTRACT_FAILED: ${result.stderr || result.error?.message || "python zipfile failed"}`,
    );
  }
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function usage(): string {
  return [
    "Usage: node --experimental-strip-types scripts/runtime/acquire-official-wheel.ts [flags]",
    "",
    "  --lock <path>  Fixed DSH runtime lock.",
    "  --out <path>   Destination runtime root.",
    "  --help         Show this help.",
  ].join("\n");
}

if (import.meta.main) {
  const values = parseArgs({
    args: process.argv.slice(2),
    options: {
      lock: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  }).values;
  if (values.help) {
    console.log(usage());
  } else {
    const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const lockPath = resolve(values.lock ?? join(repositoryRoot, "runtime-lock", "dsh-runtime.json"));
    const out = resolve(values.out ?? join(repositoryRoot, ".artifacts", "runtime"));
    try {
      console.log(JSON.stringify(await acquireOfficialWheel({ lockPath, out }), null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
