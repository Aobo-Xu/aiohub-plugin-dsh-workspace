import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PlatformKey =
  | "win32-x64"
  | "linux-x64"
  | "darwin-arm64"
  | "linux-arm64";

type Manifest = {
  sidecar?: {
    executable?: Partial<Record<PlatformKey, string>>;
  };
};

const PLATFORM_KEYS: Partial<Record<string, PlatformKey>> = {
  "win32-x64": "win32-x64",
  "linux-x64": "linux-x64",
  "darwin-arm64": "darwin-arm64",
  "linux-arm64": "linux-arm64",
};

async function main(): Promise<void> {
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const platformKey = PLATFORM_KEYS[`${process.platform}-${process.arch}`];
  if (!platformKey) {
    throw new Error(
      `DSH_SUPERVISOR_PLATFORM_UNSUPPORTED: ${process.platform}-${process.arch}`
    );
  }

  const manifest = JSON.parse(
    await readFile(resolve(repositoryRoot, "manifest.json"), "utf8")
  ) as Manifest;
  const executablePath = manifest.sidecar?.executable?.[platformKey];
  if (!executablePath) {
    throw new Error(
      `DSH_SUPERVISOR_RUNTIME_MISSING: manifest has no ${platformKey} executable`
    );
  }

  const absolutePath = resolve(repositoryRoot, executablePath);
  const repositoryRelativePath = relative(repositoryRoot, absolutePath);
  if (
    isAbsolute(repositoryRelativePath) ||
    repositoryRelativePath === ".." ||
    repositoryRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error(
      `DSH_SUPERVISOR_RUNTIME_MISSING: invalid manifest path ${executablePath}`
    );
  }

  const runtime = await stat(absolutePath).catch(() => undefined);
  if (!runtime?.isFile()) {
    throw new Error(
      `DSH_SUPERVISOR_RUNTIME_MISSING: ${platformKey} requires ${executablePath}`
    );
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
