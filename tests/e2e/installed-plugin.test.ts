import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { packagePlatform } from "../../scripts/package-platform.ts";
import { createPackageFixture, type PackageFixture } from "../fixtures/runtime-package.ts";

const fixtures: PackageFixture[] = [];

afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => rm(fixture.root, { recursive: true, force: true })));
});

async function fixture(platform: "win32-x64" | "linux-x64"): Promise<PackageFixture> {
  const created = await createPackageFixture(platform);
  fixtures.push(created);
  return created;
}

describe("packagePlatform", () => {
  it("creates a platform ZIP from a verified runtime fixture", async () => {
    const created = await fixture("win32-x64");
    const output = join(created.root, "dsh-coding-workspace-0.1.0-win32-x64.zip");

    const result = await packagePlatform({
      root: created.root,
      runtime: created.runtime,
      output,
      support: "supported",
    });

    expect(result.platform).toBe("win32-x64");
    expect(result.support).toBe("supported");
    expect(result.path).toBe(output);
    expect(result.sha256).toBe(createHash("sha256").update(await readFile(output)).digest("hex"));

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
    const created = await fixture("linux-x64");
    const output = join(created.root, "dsh-coding-workspace-0.1.0-linux-x64.zip");
    const brokenRuntime = {
      ...created.runtime,
      contractHash: "not-the-contract-hash",
    };

    await expect(packagePlatform({
      root: created.root,
      runtime: brokenRuntime,
      output,
      support: "supported",
    })).rejects.toMatchObject({ code: "RUNTIME_CONTRACT_MISMATCH" });
  });
});

