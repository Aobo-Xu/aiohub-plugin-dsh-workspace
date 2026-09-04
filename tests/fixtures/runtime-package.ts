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
  await mkdir(join(runtimeRoot, "licenses"), { recursive: true });
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
        version: "9.8.7-rc.6",
        licenses: [{ license: { id: "MIT" } }],
        properties: [
          {
            name: "aio:runtime-source",
            value: "official-wheel",
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
  await writeFile(
    join(runtimeRoot, "licenses", "runtime-MIT.txt"),
    "MIT License\nfixture",
  );
  await writeFile(
    join(runtimeRoot, "licenses", "runtime-THIRD_PARTY_NOTICES.md"),
    "Third-party notices fixture",
  );

  const runtimeClosure = [`bin/${runtimeBinaryName}`, `bin/${helperName}`];
  const files = [
    ...runtimeClosure.map((path, index) => ({
      path,
      sha256: index === 0 ? sha256(runtimeContent) : sha256(helperContent),
      executable: true,
    })),
    {
      path: "licenses/runtime-MIT.txt",
      sha256: sha256("MIT License\nfixture"),
      executable: false,
    },
    {
      path: "licenses/runtime-THIRD_PARTY_NOTICES.md",
      sha256: sha256("Third-party notices fixture"),
      executable: false,
    },
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
    version: "9.8.7-rc.6",
    tag: "dsh-v9.8.7-rc.6",
    commit: "a66e4702047846cdaa10c66c9d3df3951f5ea70d",
    platform,
    arch: platform.endsWith("arm64") ? "arm64" : "x64",
    artifactState: { status: "built" },
    source: {
      kind: "official-wheel",
      url: "https://files.pythonhosted.org/packages/fixed/runtime.whl",
      sha256: "1".repeat(64),
    },
    nodePkgTarget:
      platform === "win32-x64"
        ? "node24-win-x64"
        : platform === "linux-x64"
          ? "node24-linux-x64"
          : platform === "linux-arm64"
            ? "node24-linux-arm64"
            : "node24-macos-arm64",
    toolchain: { node: "not-applicable", pnpm: "not-applicable", python: "3.10", rust: "not-applicable" },
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
    version: "9.8.7-rc.6",
    tag: "dsh-v9.8.7-rc.6",
    commit: "a66e4702047846cdaa10c66c9d3df3951f5ea70d",
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
      version: platformLock.version,
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
