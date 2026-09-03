import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { packagePlatform } from "../../scripts/package-platform.ts";
import {
  createPackageFixture,
  type PackageFixture,
} from "../fixtures/runtime-package.ts";

const fixtures: PackageFixture[] = [];

afterAll(async () => {
  await Promise.all(
    fixtures.map((fixture) =>
      rm(fixture.root, { recursive: true, force: true }),
    ),
  );
});

describe("Linux ARM64 preview package", () => {
  it("does not create a deferred linux-arm64 preview package", async () => {
    const fixture = await createPackageFixture("linux-arm64");
    fixtures.push(fixture);
    const output = join(
      fixture.root,
      "dsh-coding-workspace-0.1.0-linux-arm64-preview.zip",
    );

    await expect(
      packagePlatform({
        root: fixture.root,
        runtime: fixture.runtime,
        output,
        support: "preview",
      }),
    ).rejects.toThrow("PACKAGE_PLATFORM_UNSUPPORTED: linux-arm64 (preview)");
  });
});
