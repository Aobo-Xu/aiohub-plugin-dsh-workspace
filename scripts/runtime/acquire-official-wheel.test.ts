import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireOfficialWheel,
  type WheelExtractor,
} from "./acquire-official-wheel.ts";

const roots: string[] = [];
const wheelBytes = Buffer.from("official-wheel-fixture");
const wheelSha256 = createHash("sha256").update(wheelBytes).digest("hex");

async function fixture(): Promise<{ lockPath: string; out: string }> {
  const root = await mkdtemp(join(tmpdir(), "dsh-official-wheel-"));
  roots.push(root);
  const lockPath = join(root, "runtime-lock.json");
  const out = join(root, "runtime");
  await writeFile(
    lockPath,
    JSON.stringify({
      schemaVersion: 1,
      version: "9.8.7-rc.6",
      source: {
        kind: "official-wheel",
        url: "https://files.pythonhosted.org/packages/fixed/runtime.whl",
        sha256: wheelSha256,
      },
      cyclonedxPath: "sbom/runtime.cdx.json",
      platforms: {
        "win32-x64": {
          artifactState: { status: "built" },
          files: [],
        },
      },
    }),
  );
  return { lockPath, out };
}

const extractFixture: WheelExtractor = async (_wheel, destination) => {
  const runtime = join(destination, "deepseek_harness_runtime", "runtime");
  const licenses = join(
    destination,
    "deepseek_harness_runtime_bin-9.8.7rc6.dist-info",
    "licenses",
  );
  await mkdir(runtime, { recursive: true });
  await mkdir(licenses, { recursive: true });
  await writeFile(
    join(runtime, "deepseek-harness-sdk-runtime-win-x64.exe"),
    "runtime",
  );
  await writeFile(
    join(runtime, "deepseek-harness-sdk-runtime-win-x64-rg.exe"),
    "rg",
  );
  await writeFile(join(licenses, "LICENSE"), "MIT fixture");
  await writeFile(join(licenses, "THIRD_PARTY_NOTICES.md"), "notices");
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("official DSH runtime wheel acquisition", () => {
  it("verifies the pinned wheel before extracting the audited Windows closure", async () => {
    const { lockPath, out } = await fixture();

    const result = await acquireOfficialWheel(
      { lockPath, out },
      {
        download: async () => wheelBytes,
        extract: extractFixture,
        generateSbom: async (_lock, path) => {
          await mkdir(join(out, "sbom"), { recursive: true });
          await writeFile(path, "sbom");
        },
      },
    );

    expect(result.platform).toBe("win32-x64");
    await expect(readFile(join(out, "bin", "deepseek-harness-sdk-runtime-win-x64.exe"), "utf8")).resolves.toBe("runtime");
    await expect(readFile(join(out, "bin", "deepseek-harness-sdk-runtime-win-x64-rg.exe"), "utf8")).resolves.toBe("rg");
    await expect(readFile(join(out, "licenses", "runtime-MIT.txt"), "utf8")).resolves.toBe("MIT fixture");
    await expect(readFile(join(out, "licenses", "runtime-THIRD_PARTY_NOTICES.md"), "utf8")).resolves.toBe("notices");
  });

  it("fails closed before extraction when downloaded wheel bytes drift", async () => {
    const { lockPath, out } = await fixture();
    let extracted = false;

    await expect(
      acquireOfficialWheel(
        { lockPath, out },
        {
          download: async () => Buffer.from("tampered"),
          extract: async () => {
            extracted = true;
          },
          generateSbom: async () => undefined,
        },
      ),
    ).rejects.toThrow("RUNTIME_WHEEL_CHECKSUM_MISMATCH");
    expect(extracted).toBe(false);
  });
});
