import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { packagePlatform } from "../../scripts/package-platform.ts";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function createPackageFixture(platform: "win32-x64" | "linux-x64" | "darwin-arm64" | "linux-arm64" = "win32-x64") {
  const root = await mkdtemp(join(tmpdir(), "dsh-package-"));
  roots.push(root);

  const runtimeRoot = join(root, "runtime");
  await mkdir(join(runtimeRoot, "bin"), { recursive: true });
  await mkdir(join(runtimeRoot, "sbom"), { recursive: true });

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
        version: "0.1.2-alpha.3",
        licenses: [{ license: { id: "MIT" } }],
        properties: [
          { name: "aio:runtime-source", value: "project-built-from-official-source" },
          { name: "aio:contract-hash", value: "96af8af6cdb538da2cd13c53eb4dd640f0ca233aab68b209d82fc744e01da519" },
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
    contributions: [{ type: "capability", id: "execution-domain:dsh", version: 1, stability: "stable" }],
  };

  const lock = {
    schemaVersion: 1,
    version: "0.1.2-alpha.3",
    tag: "dsh-v0.1.2-alpha.3",
    commit: "dd6322d604e00eec1ba5e0c8541159906a21094a",
    platform,
    arch: platform.endsWith("arm64") ? "arm64" : "x64",
    artifactState: { status: "built" },
    source: {
      kind: "project-built-from-official-source",
      tag: "dsh-v0.1.2-alpha.3",
      commit: "dd6322d604e00eec1ba5e0c8541159906a21094a",
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
    contractHash: "96af8af6cdb538da2cd13c53eb4dd640f0ca233aab68b209d82fc744e01da519",
    aioSemverRange: ">=0.7.0-alpha.4",
  };

  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(join(root, "runtime-lock.json"), JSON.stringify(lock, null, 2));

  return {
    root,
    runtime: {
      platform,
      root: runtimeRoot,
      source: lock.source,
      artifactState: lock.artifactState,
      files,
      license: lock.license,
      contractHash: lock.contractHash,
      runtimeClosure,
      cyclonedxPath: lock.cyclonedxPath,
      nodePkgTarget: lock.nodePkgTarget,
      toolchain: lock.toolchain,
    },
  };
}

describe("packagePlatform", () => {
  it("creates a platform ZIP from a verified runtime fixture", async () => {
    const fixture = await createPackageFixture("win32-x64");
    const output = join(fixture.root, "dsh-coding-workspace-0.1.0-win32-x64.zip");

    const result = await packagePlatform({
      root: fixture.root,
      runtime: fixture.runtime,
      output,
      support: "supported",
    });

    expect(result.platform).toBe("win32-x64");
    expect(result.support).toBe("supported");
    expect(result.path).toBe(output);
    expect(result.sha256).toBe(sha256(await readFile(output)));

    const listing = spawnSync("tar", ["-tf", output], { encoding: "utf8" });
    expect(listing.status).toBe(0);
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
    expect(entries).toEqual(expect.arrayContaining([
      "manifest.json",
      "runtime-lock.json",
      "support-results.json",
      "bin/deepseek-harness-sdk-runtime-win-x64.exe",
      "bin/deepseek-harness-sdk-runtime-win-x64-rg.exe",
      "sbom/runtime.cdx.json",
    ]));

    const supportContent = spawnSync("tar", ["-xOf", output, "support-results.json"], {
      encoding: "utf8",
    });
    expect(supportContent.status).toBe(0);
    const support = JSON.parse(supportContent.stdout);
    expect(support).toEqual({
      platform: "win32-x64",
      support: "supported",
      contractHash: "96af8af6cdb538da2cd13c53eb4dd640f0ca233aab68b209d82fc744e01da519",
    });
  });

  it("rejects an unverified runtime before creating a ZIP", async () => {
    const fixture = await createPackageFixture("linux-x64");
    const output = join(fixture.root, "dsh-coding-workspace-0.1.0-linux-x64.zip");
    const brokenRuntime = {
      ...fixture.runtime,
      contractHash: "not-the-contract-hash",
    };

    await expect(packagePlatform({
      root: fixture.root,
      runtime: brokenRuntime,
      output,
      support: "supported",
    })).rejects.toMatchObject({ code: "RUNTIME_CONTRACT_MISMATCH" });
  });
});


