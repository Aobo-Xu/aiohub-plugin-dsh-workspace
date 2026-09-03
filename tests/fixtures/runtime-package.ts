import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { VerifiedRuntime } from "../../scripts/runtime/verify-runtime.ts";

export type PackageFixture = {
  root: string;
  runtime: VerifiedRuntime;
  supervisorPath: string;
};

export async function createPackageFixture(
  platform:
    "win32-x64" | "linux-x64" | "linux-arm64" | "darwin-arm64" = "win32-x64",
): Promise<PackageFixture> {
  const root = await mkdtemp(join(tmpdir(), "dsh-package-"));
  const runtimeRoot = join(root, "runtime");
  await mkdir(join(runtimeRoot, "bin"), { recursive: true });
  await mkdir(join(runtimeRoot, "sbom"), { recursive: true });
  const supervisorPath = join(
    root,
    "bin",
    platform,
    `aio-dsh-supervisor${platform === "win32-x64" ? ".exe" : ""}`,
  );
  await mkdir(dirname(supervisorPath), { recursive: true });
  await writeFile(supervisorPath, "supervisor binary fixture");
  await writeFile(join(root, "LICENSE"), "Apache License fixture\n");

  const runtimeBinaryName =
    platform === "win32-x64"
      ? "deepseek-harness-sdk-runtime-win-x64.exe"
      : platform === "linux-x64"
        ? "deepseek-harness-sdk-runtime-linux-x64"
        : platform === "linux-arm64"
          ? "deepseek-harness-sdk-runtime-linux-arm64"
          : "deepseek-harness-sdk-runtime-macos-arm64";
  const helperBase = runtimeBinaryName.replace(/\.exe$/, "");
  const helperName = `${helperBase}-rg${platform === "win32-x64" ? ".exe" : ""}`;

  const runtimeContent = "runtime binary fixture";
  const helperContent = "ripgrep fixture";
  const sbomContent = JSON.stringify({
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    metadata: {
      component: {
        type: "application",
        name: "deepseek-harness-runtime",
        version: "0.1.2-alpha.5",
        licenses: [{ license: { id: "MIT" } }],
        properties: [
          {
            name: "aio:runtime-source",
            value: "project-built-from-official-source",
          },
          {
            name: "aio:contract-hash",
            value:
              "96af8af6cdb538da2cd13c53eb4dd640f0ca233aab68b209d82fc744e01da519",
          },
        ],
      },
    },
  });

  await writeFile(join(runtimeRoot, "bin", runtimeBinaryName), runtimeContent);
  await writeFile(join(runtimeRoot, "bin", helperName), helperContent);
  await writeFile(join(runtimeRoot, "sbom", "runtime.cdx.json"), sbomContent);

  const runtimeClosure = [`bin/${runtimeBinaryName}`, `bin/${helperName}`];
  const files = [
    ...runtimeClosure.map((path, index) => ({
      path,
      sha256: index === 0 ? sha256(runtimeContent) : sha256(helperContent),
      executable: true,
    })),
    {
      path: "sbom/runtime.cdx.json",
      sha256: sha256(sbomContent),
      executable: false,
    },
  ];

  const manifest = {
    id: "dsh-coding-workspace",
    name: "Coding工作站",
    version: "0.1.0",
    type: "sidecar",
    host: { apiVersion: 3, platforms: [platform] },
    sidecar: {
      executable: {
        [platform]: `bin/${platform}/aio-dsh-supervisor${platform === "win32-x64" ? ".exe" : ""}`,
      },
      resident: true,
      startupMethod: "initialize",
      startupParams: {},
    },
    contributions: [
      {
        type: "capability",
        id: "execution-domain:dsh",
        version: 1,
        stability: "stable",
      },
    ],
  };

  const platformLock = {
    schemaVersion: 1,
    version: "0.1.2-alpha.5",
    tag: "dsh-v0.1.2-alpha.5",
    commit: "db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5",
    platform,
    arch: platform.endsWith("arm64") ? "arm64" : "x64",
    artifactState: { status: "built" },
    source: {
      kind: "project-built-from-official-source",
      tag: "dsh-v0.1.2-alpha.5",
      commit: "db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5",
    },
    nodePkgTarget:
      platform === "win32-x64"
        ? "node24-win-x64"
        : platform === "linux-x64"
          ? "node24-linux-x64"
          : platform === "linux-arm64"
            ? "node24-linux-arm64"
            : "node24-macos-arm64",
    toolchain: { node: "24", pnpm: "11.7.0", python: "3.10", rust: "1.89.0" },
    files,
    runtimeClosure,
    license: "MIT",
    cyclonedxPath: "sbom/runtime.cdx.json",
    profileVersion: "dsh-runtime-profile-v1",
    contractHash:
      "96af8af6cdb538da2cd13c53eb4dd640f0ca233aab68b209d82fc744e01da519",
    aioSemverRange: ">=0.7.0-alpha.4",
  };

  const lock = {
    schemaVersion: 1,
    version: "0.1.2-alpha.5",
    tag: "dsh-v0.1.2-alpha.5",
    commit: "db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5",
    source: platformLock.source,
    license: platformLock.license,
    cyclonedxPath: platformLock.cyclonedxPath,
    profileVersion: platformLock.profileVersion,
    contractHash: platformLock.contractHash,
    aioSemverRange: platformLock.aioSemverRange,
    toolchain: platformLock.toolchain,
    platforms: { [platform]: platformLock },
  };

  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  await writeFile(
    join(root, "runtime-lock.json"),
    JSON.stringify(lock, null, 2),
  );

  return {
    root,
    runtime: {
      platform,
      root: runtimeRoot,
      source: platformLock.source,
      artifactState: platformLock.artifactState,
      files,
      license: platformLock.license,
      contractHash: platformLock.contractHash,
      runtimeClosure,
      cyclonedxPath: platformLock.cyclonedxPath,
      nodePkgTarget: platformLock.nodePkgTarget,
      toolchain: platformLock.toolchain,
    },
    supervisorPath,
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
