import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { packagePlatform } from "../../scripts/package-platform.ts";
import {
  createPackageFixture,
  type PackageFixture,
} from "../fixtures/runtime-package.ts";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function withFixture(
  platform: "win32-x64" | "linux-x64",
): Promise<PackageFixture> {
  const fixture = await createPackageFixture(platform);
  roots.push(fixture.root);
  return fixture;
}

describe("installed DSH plugin package", () => {
  it("creates a Windows release ZIP with the manifest supervisor and persistent release metadata", async () => {
    const fixture = await withFixture("win32-x64");
    const output = join(
      fixture.root,
      "dsh-coding-workspace-0.1.0-win32-x64.zip",
    );
    const installRoot = await mkdtemp(join(tmpdir(), "dsh-installed-"));
    roots.push(installRoot);

    const result = await packagePlatform({
      root: fixture.root,
      runtime: fixture.runtime,
      output,
      support: "supported",
      supervisorPath: fixture.supervisorPath,
    });

    expect(result.platform).toBe("win32-x64");
    expect(result.support).toBe("supported");

    const extract = spawnSync("tar", ["-xf", output, "-C", installRoot], {
      encoding: "utf8",
    });
    expect(extract.status).toBe(0);

    const manifest = JSON.parse(
      await readFile(join(installRoot, "manifest.json"), "utf8"),
    );
    expect(manifest.id).toBe("dsh-coding-workspace");
    expect(manifest.name).toBe("Coding工作站");
    expect(manifest.type).toBe("sidecar");
    expect(manifest.host.platforms).toEqual(["win32-x64"]);
    expect(manifest.sidecar.executable).toEqual({
      "win32-x64": "bin/win32-x64/aio-dsh-supervisor.exe",
    });
    expect(
      await readFile(
        join(installRoot, manifest.sidecar.executable["win32-x64"]),
        "utf8",
      ),
    ).toBe("supervisor binary fixture");

    const runtimeLock = JSON.parse(
      await readFile(join(installRoot, "runtime-lock.json"), "utf8"),
    );
    expect(runtimeLock.platform).toBe("win32-x64");
    expect(runtimeLock.platforms).toBeUndefined();
    expect(runtimeLock.releaseClosure).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "bin/win32-x64/aio-dsh-supervisor.exe",
          sha256: createHash("sha256")
            .update("supervisor binary fixture")
            .digest("hex"),
          executable: true,
        }),
      ]),
    );
    expect(runtimeLock.artifactState.status).toBe("built");
    expect(runtimeLock.runtimeClosure).toEqual([
      "bin/deepseek-harness-sdk-runtime-win-x64.exe",
      "bin/deepseek-harness-sdk-runtime-win-x64-rg.exe",
    ]);

    const support = JSON.parse(
      await readFile(join(installRoot, "support-results.json"), "utf8"),
    );
    expect(support).toEqual({
      platform: "win32-x64",
      support: "supported",
      contractHash: runtimeLock.contractHash,
    });

    expect(
      await readFile(join(installRoot, "licenses", "runtime-MIT.txt"), "utf8"),
    ).toContain("MIT License");
    expect(await readFile(`${output}.sha256`, "utf8")).toBe(
      `${result.sha256}  ${basename(output)}\n`,
    );

    const runtimeBinary = await readFile(
      join(installRoot, "bin/deepseek-harness-sdk-runtime-win-x64.exe"),
    );
    const ripgrep = await readFile(
      join(installRoot, "bin/deepseek-harness-sdk-runtime-win-x64-rg.exe"),
    );
    expect(createHash("sha256").update(runtimeBinary).digest("hex")).toBe(
      runtimeLock.files[0]?.sha256,
    );
    expect(createHash("sha256").update(ripgrep).digest("hex")).toBe(
      runtimeLock.files[1]?.sha256,
    );
  });

  it("rejects an unverified runtime before creating a ZIP", async () => {
    const fixture = await withFixture("win32-x64");
    const output = join(
      fixture.root,
      "dsh-coding-workspace-0.1.0-win32-x64.zip",
    );
    const brokenRuntime = {
      ...fixture.runtime,
      contractHash: "not-the-contract-hash",
    };

    await expect(
      packagePlatform({
        root: fixture.root,
        runtime: brokenRuntime,
        output,
        support: "supported",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_CONTRACT_MISMATCH" });
  });
});
