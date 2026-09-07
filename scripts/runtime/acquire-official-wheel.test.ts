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

const pendingEntry = {
  schemaVersion: 1,
  version: "0.1.3-alpha.2",
  tag: "dsh-v0.1.3-alpha.2",
  commit: "82a5fd61a7cf5c293cec4bdff68f455398d685e9",
  source: {
    kind: "official-wheel",
    url: "https://files.pythonhosted.org/packages/fixed/pending.whl",
    sha256: "0".repeat(64),
  },
  officialWheel: {
    status: "acquisition-pending",
    distribution: "deepseek-harness-runtime-bin",
    filename: "deepseek_harness_runtime_bin-0.1.3a2-py3-none-win_amd64.whl",
    platform: "win32-x64",
    url: "https://files.pythonhosted.org/packages/fixed/pending.whl",
    sha256: "0".repeat(64),
  },
  license: "MIT",
  licenseResult: { spdx: "MIT", source: "official-wheel-metadata" },
  cyclonedxPath: "sbom/runtime.cdx.json",
  contractHash:
    "96af8af6cdb538da2cd13c53eb4dd640f0ca233aab68b209d82fc744e01da519",
  toolchain: {
    node: "not-applicable",
    pnpm: "not-applicable",
    python: "3.10",
    rust: "not-applicable",
  },
  platforms: {
    "win32-x64": {
      artifactState: { status: "not-built", reason: "wheel-acquisition-pending" },
      files: [],
    },
  },
};

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

  it("acquires the pinned available release from a multi-release catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-catalog-acquire-"));
    roots.push(root);
    const lockPath = join(root, "runtime-lock.json");
    const out = join(root, "runtime");
    await writeFile(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        releases: [
          {
            schemaVersion: 1,
            version: "9.8.7-rc.6",
            source: {
              kind: "official-wheel",
              url: "https://files.pythonhosted.org/packages/fixed/runtime.whl",
              sha256: wheelSha256,
            },
            officialWheel: { status: "available" },
            cyclonedxPath: "sbom/runtime.cdx.json",
            platforms: {
              "win32-x64": {
                artifactState: { status: "built" },
                files: [],
              },
            },
          },
          pendingEntry,
        ],
      }),
    );

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
    await expect(
      readFile(join(out, "bin", "deepseek-harness-sdk-runtime-win-x64.exe"), "utf8"),
    ).resolves.toBe("runtime");
  });

  it("rejects an acquisition-pending release without touching the network", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-pending-acquire-"));
    roots.push(root);
    const lockPath = join(root, "runtime-lock.json");
    const out = join(root, "runtime");
    await writeFile(
      lockPath,
      JSON.stringify({ schemaVersion: 1, releases: [pendingEntry] }),
    );
    let downloaded = false;

    await expect(
      acquireOfficialWheel(
        { lockPath, out },
        {
          download: async () => {
            downloaded = true;
            return wheelBytes;
          },
          extract: extractFixture,
          generateSbom: async () => undefined,
        },
      ),
    ).rejects.toThrow(
      "RUNTIME_WHEEL_ACQUISITION_PENDING: dsh-v0.1.3-alpha.2",
    );
    expect(downloaded).toBe(false);
  });
});
