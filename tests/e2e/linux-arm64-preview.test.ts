import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { packagePlatform } from "../../scripts/package-platform.ts";
import { createPackageFixture, type PackageFixture } from "../fixtures/runtime-package.ts";

const fixtures: PackageFixture[] = [];

afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => rm(fixture.root, { recursive: true, force: true })));
});

describe("Linux ARM64 preview package", () => {
  it("packages linux-arm64 with preview metadata", async () => {
    const fixture = await createPackageFixture("linux-arm64");
    fixtures.push(fixture);
    const output = join(fixture.root, "dsh-coding-workspace-0.1.0-linux-arm64-preview.zip");

    const result = await packagePlatform({
      root: fixture.root,
      runtime: fixture.runtime,
      output,
      support: "preview",
    });

    expect(result.platform).toBe("linux-arm64");
    expect(result.support).toBe("preview");
    expect(result.path).toBe(output);

    const listing = spawnTarList(output);
    expect(listing).toEqual(expect.arrayContaining([
      "manifest.json",
      "runtime-lock.json",
      "support-results.json",
      "bin/deepseek-harness-sdk-runtime-linux-arm64",
      "bin/deepseek-harness-sdk-runtime-linux-arm64-rg",
      "sbom/runtime.cdx.json",
    ]));
  });
});

function spawnTarList(path: string): string[] {
  const result = spawnSync("tar", ["-tf", path], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.split(/\r?\n/).filter(Boolean);
}
