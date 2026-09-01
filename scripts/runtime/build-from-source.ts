import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  DSH_COMMIT,
  DSH_TAG,
  type PlatformKey,
  currentPlatform,
} from "./resolve-runtime.ts";

const repositoryRoot = dirname(
  dirname(dirname(fileURLToPath(import.meta.url)))
);

const targets: Record<PlatformKey, string> = {
  "win32-x64": "node24-win-x64",
  "linux-x64": "node24-linux-x64",
  "linux-arm64": "node24-linux-arm64",
  "darwin-arm64": "node24-macos-arm64",
};

const toolchain = {
  node: "24",
  pnpm: "11.7.0",
  python: "3.10",
  rust: "1.89.0",
} as const;

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string } = {}
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `RUNTIME_BUILD_PREREQUISITE_MISMATCH: failed to run ${command} ${args.join(" ")}`
    );
  }
  return (result.stdout ?? "").trim();
}

function verifySource(sourceRoot: string): void {
  if (!existsSync(sourceRoot)) {
    throw new Error(`RUNTIME_SOURCE_MISSING: ${sourceRoot}`);
  }
  const head = run("git", ["rev-parse", "HEAD"], { cwd: sourceRoot });
  if (head !== DSH_COMMIT) {
    throw new Error(`RUNTIME_SOURCE_COMMIT_MISMATCH: ${head}`);
  }
  const tag = run("git", ["tag", "--points-at", "HEAD"], { cwd: sourceRoot });
  if (tag !== DSH_TAG) {
    throw new Error(`RUNTIME_SOURCE_TAG_MISMATCH: ${tag}`);
  }
}

function verifyToolchain(): void {
  const nodeVersion = process.versions.node;
  if (!nodeVersion.startsWith(`${toolchain.node}.`)) {
    throw new Error(
      `RUNTIME_BUILD_PREREQUISITE_MISMATCH: Node ${toolchain.node} is required, got ${nodeVersion}`
    );
  }
  const pnpmVersion = run("pnpm", ["--version"]);
  if (pnpmVersion !== toolchain.pnpm) {
    throw new Error(
      `RUNTIME_BUILD_PREREQUISITE_MISMATCH: pnpm ${toolchain.pnpm} is required, got ${pnpmVersion}`
    );
  }
  const pythonVersion = run("python", ["--version"]);
  if (!pythonVersion.startsWith(`Python ${toolchain.python}.`)) {
    throw new Error(
      `RUNTIME_BUILD_PREREQUISITE_MISMATCH: Python ${toolchain.python} is required, got ${pythonVersion}`
    );
  }
  const rustVersion = run("rustc", ["--version"]);
  if (!rustVersion.startsWith(`rustc ${toolchain.rust} `)) {
    throw new Error(
      `RUNTIME_BUILD_PREREQUISITE_MISMATCH: Rust ${toolchain.rust} is required, got ${rustVersion}`
    );
  }
}

async function verifySourceLock(sourceRoot: string): Promise<string> {
  const lockPath = join(sourceRoot, "pnpm-lock.yaml");
  if (!existsSync(lockPath)) {
    throw new Error(`RUNTIME_SOURCE_LOCK_MISSING: ${lockPath}`);
  }
  const content = await readFile(lockPath, "utf8");
  return content;
}

function usage(): string {
  return [
    "Usage: node --experimental-strip-types scripts/runtime/build-from-source.ts [flags]",
    "",
    "  --source-root <path>  Pinned DSH source checkout.",
    "  --platform <key>      win32-x64, linux-x64, linux-arm64, or darwin-arm64.",
    "  --out <path>          Output runtime root.",
    "  --help                Show this help.",
    "",
    `Build prerequisites: Node ${toolchain.node}, pnpm ${toolchain.pnpm}, Python ${toolchain.python}, Rust ${toolchain.rust}.`,
    "The source must be pinned to dsh-v0.1.2-alpha.3 at dd6322d604e00eec1ba5e0c8541159906a21094a.",
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
    const sourceRoot = values["source-root"]
      ? resolve(values["source-root"])
      : undefined;
    const platform =
      values.platform === undefined
        ? currentPlatform()
        : values.platform === "win32-x64" ||
            values.platform === "linux-x64" ||
            values.platform === "linux-arm64" ||
            values.platform === "darwin-arm64"
          ? values.platform
          : undefined;
    if (!sourceRoot || !platform || !values.out) {
      console.error(usage());
      process.exitCode = 1;
      } else {
      try {
        verifyToolchain();
        verifySource(sourceRoot);
        await verifySourceLock(sourceRoot);
        const target = targets[platform];
        console.log(
          `building ${target} from ${DSH_TAG} (${DSH_COMMIT}) into ${resolve(values.out)}`
        );
        console.error(
          "RUNTIME_BUILD_NOT_IMPLEMENTED_ON_THIS_HOST: native runner build is required"
        );
        process.exitCode = 1;
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    }
  }
}
