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

describe("Flatpak compatibility package", () => {
  it("packages a linux-x64 plugin payload without broad filesystem permissions", async () => {
    const fixture = await createPackageFixture("linux-x64");
    fixtures.push(fixture);
    const output = join(fixture.root, "dsh-coding-workspace-0.1.0-linux-x64.zip");

    const result = await packagePlatform({
      root: fixture.root,
      runtime: fixture.runtime,
      output,
      support: "supported",
    });

    expect(result.platform).toBe("linux-x64");
    expect(result.support).toBe("supported");

    const listing = spawnSync("tar", ["-tf", output], { encoding: "utf8" });
    expect(listing.status).toBe(0);
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
    expect(entries).toEqual(expect.arrayContaining([
      "manifest.json",
      "runtime-lock.json",
      "support-results.json",
      "bin/deepseek-harness-sdk-runtime-linux-x64",
      "bin/deepseek-harness-sdk-runtime-linux-x64-rg",
      "sbom/runtime.cdx.json",
    ]));

    const manifestContent = spawnSync("tar", ["-xOf", output, "manifest.json"], {
      encoding: "utf8",
    });
    expect(manifestContent.status).toBe(0);
    const manifest = JSON.parse(manifestContent.stdout);
    expect(manifest.host.platforms).toEqual(["linux-x64"]);
    expect(manifest.sidecar.executable["linux-x64"]).toBe(
      "bin/linux-x64/aio-dsh-supervisor"
    );
  });
});
