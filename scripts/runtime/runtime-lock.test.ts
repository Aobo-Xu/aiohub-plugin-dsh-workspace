import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  DSH_CONTRACT_HASH,
  loadRuntimeLock,
  loadRuntimeLockCatalog,
  officialWheelStatus,
  resolveRuntime,
  selectRuntimeByEvidence,
  type RuntimeLockEntry,
  type VerifiedRuntime,
} from "./resolve-runtime.ts";
import { generateSbom } from "./generate-sbom.ts";
import { verifyRuntime } from "./verify-runtime.ts";

const CONTRACT_HASH =
  "96af8af6cdb538da2cd13c53eb4dd640f0ca233aab68b209d82fc744e01da519";
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const roots: string[] = [];

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function fixtureRuntime(): Promise<VerifiedRuntime> {
  const root = await mkdtemp(join(tmpdir(), "dsh-runtime-rc1-"));
  roots.push(root);
  const contents = new Map([
    ["bin/deepseek-harness-sdk-runtime-win-x64.exe", "runtime"],
    ["bin/deepseek-harness-sdk-runtime-win-x64-rg.exe", "rg"],
    ["licenses/runtime-MIT.txt", "license"],
    ["licenses/runtime-THIRD_PARTY_NOTICES.md", "notices"],
    [
      "sbom/runtime.cdx.json",
      `${JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        metadata: {
          component: {
            name: "deepseek-harness-runtime",
            version: "9.8.7-rc.6",
            properties: [
              { name: "aio:runtime-source", value: "official-wheel" },
              { name: "aio:contract-hash", value: CONTRACT_HASH },
            ],
          },
        },
      })}\n`,
    ],
  ]);
  for (const [path, content] of contents) {
    const target = join(root, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return {
    version: "9.8.7-rc.6",
    platform: "win32-x64",
    root,
    source: {
      kind: "official-wheel",
      url: "https://files.pythonhosted.org/packages/fixed/runtime.whl",
      sha256: "1".repeat(64),
    },
    artifactState: { status: "built" },
    files: [...contents].map(([path, content]) => ({
      path,
      sha256: sha256(content),
      executable: path.endsWith(".exe"),
    })),
    license: "MIT",
    contractHash: CONTRACT_HASH,
    runtimeClosure: [
      "bin/deepseek-harness-sdk-runtime-win-x64.exe",
      "bin/deepseek-harness-sdk-runtime-win-x64-rg.exe",
    ],
    cyclonedxPath: "sbom/runtime.cdx.json",
    nodePkgTarget: "node24-win-x64",
    toolchain: {
      node: "not-applicable",
      pnpm: "not-applicable",
      python: "3.10",
      rust: "not-applicable",
    },
  };
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("version-independent official runtime lock", () => {
  it("resolves release identity from the lock instead of code constants", async () => {
    const runtime = await resolveRuntime("win32-x64");
    const lock = await loadRuntimeLock();
    expect(runtime.version).toBe(lock.version);
    expect(runtime.source).toEqual(lock.source);
    expect(officialWheelStatus(lock, "win32-x64")).toMatchObject({
      status: "available",
    });
  });

  it("accepts a future version lock without code changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-future-lock-"));
    roots.push(root);
    const catalog = JSON.parse(
      await readFile(join(repositoryRoot, "runtime-lock", "dsh-runtime.json"), "utf8"),
    );
    const current = catalog.releases[0];
    current.version = "9.8.7-rc.6";
    current.tag = "dsh-v9.8.7-rc.6";
    current.commit = "2".repeat(40);
    current.officialWheel.filename =
      "deepseek_harness_runtime_bin-9.8.7rc6-py3-none-win_amd64.whl";
    const path = join(root, "runtime-lock.json");
    await writeFile(path, JSON.stringify(current));

    await expect(loadRuntimeLock(path)).resolves.toMatchObject({
      version: "9.8.7-rc.6",
      tag: "dsh-v9.8.7-rc.6",
    });
  });

  it("accepts a complete verified wheel closure", async () => {
    await expect(verifyRuntime(await fixtureRuntime())).resolves.toMatchObject({
      source: { kind: "official-wheel" },
    });
  });

  it("rejects non-PyPI artifact URLs", async () => {
    const runtime = await fixtureRuntime();
    runtime.source = {
      kind: "official-wheel",
      url: "https://example.com/actions/runs/1/runtime.whl",
      sha256: "1".repeat(64),
    };
    await expect(verifyRuntime(runtime)).rejects.toMatchObject({
      code: "RUNTIME_TEMPORARY_ACTIONS_ARTIFACT",
    });
  });

  it("rejects extracted file drift", async () => {
    const runtime = await fixtureRuntime();
    runtime.files[0] = { ...runtime.files[0], sha256: "0".repeat(64) };
    await expect(verifyRuntime(runtime)).rejects.toMatchObject({
      code: "RUNTIME_CHECKSUM_MISMATCH",
    });
  });

  it("generates CycloneDX metadata with wheel provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sbom-rc1-"));
    roots.push(root);
    const output = join(root, "runtime.cdx.json");
    await generateSbom(
      join(repositoryRoot, "runtime-lock", "dsh-runtime.json"),
      output,
    );
    const sbom = JSON.parse(await readFile(output, "utf8"));
    expect(sbom.metadata.component).toMatchObject({
      version: expect.any(String),
      properties: expect.arrayContaining([
        { name: "aio:runtime-source", value: "official-wheel" },
      ]),
    });
  });

  it("routes runtime acquisition through Node", async () => {
    const pkg = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
    expect(pkg.scripts["runtime:acquire-wheel"]).toContain(
      "node --experimental-strip-types",
    );
    expect(pkg.scripts["build:dsh-source"]).toBeUndefined();
  });
});

describe("dual-release runtime baseline fixtures", () => {
  const rc1Platform = "win32-x64" as const;

  it("keeps both immutable release fixture entries readable and distinct", async () => {
    const catalog = await loadRuntimeLockCatalog();

    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.releases.map((entry) => entry.version)).toEqual([
      "0.1.2-rc.1",
      "0.1.3-alpha.2",
    ]);
    expect(catalog.releases.map((entry) => entry.tag)).toEqual([
      "dsh-v0.1.2-rc.1",
      "dsh-v0.1.3-alpha.2",
    ]);
    expect(new Set(catalog.releases.map((entry) => entry.commit)).size).toBe(2);
    expect(new Set(catalog.releases.map((entry) => entry.tag)).size).toBe(2);
  });

  it.each([
    [
      "0.1.2-rc.1",
      "dsh-v0.1.2-rc.1",
      "a66e4702047846cdaa10c66c9d3df3951f5ea70d",
      "deepseek_harness_runtime_bin-0.1.2rc1-py3-none-win_amd64.whl",
      "390bd8cd5f8700fc609c58e1ccb78091d5c8c6e11c21656e284e0f68da0e148f",
    ],
    [
      "0.1.3-alpha.2",
      "dsh-v0.1.3-alpha.2",
      "82a5fd61a7cf5c293cec4bdff68f455398d685e9",
      "deepseek_harness_runtime_bin-0.1.3a2-py3-none-win_amd64.whl",
      undefined,
    ],
  ] as const)(
    "preserves immutable identity for %s",
    async (version, tag, commit, wheelFilename, wheelSha256) => {
      const catalog = await loadRuntimeLockCatalog();
      const entry = catalog.releases.find(
        (candidate) => candidate.version === version,
      );
      expect(entry).toBeDefined();

      expect(entry!.tag).toBe(tag);
      expect(entry!.commit).toBe(commit);
      expect(entry!.source.kind).toBe("official-wheel");
      expect(entry!.officialWheel.filename).toBe(wheelFilename);
      if (wheelSha256 === undefined) {
        expect(entry!.source.sha256).toMatch(/^[0-9a-f]{64}$/);
      } else {
        expect(entry!.source.sha256).toBe(wheelSha256);
      }
      expect(entry!.source.url).toBe(entry!.officialWheel.url);
      expect(entry!.source.sha256).toBe(entry!.officialWheel.sha256);
      expect(entry!.licenseResult).toMatchObject({
        spdx: "MIT",
        source: "official-wheel-metadata",
      });
      expect(entry!.cyclonedxPath).toBe("sbom/runtime.cdx.json");
      expect(entry!.officialWheel.status).toBe(
        wheelSha256 === undefined ? "acquisition-pending" : "available",
      );
      const platform = entry!.platforms[rc1Platform];
      expect(platform.platform).toBe(rc1Platform);
      expect(platform.pythonTarget).toBe("win_amd64");
      expect(platform.runtimeClosure.length).toBeGreaterThan(0);
      if (platform.artifactState.status === "built") {
        expect(platform.files.map((file) => file.path)).toEqual(
          expect.arrayContaining(platform.runtimeClosure),
        );
      } else {
        expect(platform.files).toEqual([]);
      }
    },
  );

  it("resolves only capability and schema evidence, never version guesses", async () => {
    const catalog = await loadRuntimeLockCatalog();

    const rc1 = selectRuntimeByEvidence(catalog, {
      schemaVersion: 1,
      capabilities: { capabilities: ["dsh"] },
    });
    expect(rc1).toBeDefined();
    expect(rc1!.version).toBe("0.1.2-rc.1");
    expect(rc1!.tag).toBe("dsh-v0.1.2-rc.1");
    expect(rc1!.contractHash).toBe(DSH_CONTRACT_HASH);

    // A startswith("0.1.3") style version guess must not select alpha.2.
    const guessed = selectRuntimeByEvidence(catalog, {
      schemaVersion: 1,
      versionPrefix: "0.1.3",
    } as unknown as RuntimeSelectionEvidence);
    expect(guessed).toBeUndefined();
    expect(
      selectRuntimeByEvidence(catalog, {
        schemaVersion: 1,
        versionPrefix: "0.1.2",
      } as unknown as RuntimeSelectionEvidence),
    ).toBeUndefined();

    // Missing or mismatched schema evidence selects nothing.
    expect(
      selectRuntimeByEvidence(catalog, {
        schemaVersion: 2,
        capabilities: { capabilities: ["dsh"] },
      } as unknown as RuntimeSelectionEvidence),
    ).toBeUndefined();
    expect(
      selectRuntimeByEvidence(catalog, {
        schemaVersion: 1,
        capabilities: { capabilities: [] },
      }),
    ).toBeUndefined();
  });

  it("never reports an acquisition-pending wheel as available", async () => {
    const catalog = await loadRuntimeLockCatalog();
    const pending = catalog.releases.find(
      (entry) => entry.version === "0.1.3-alpha.2",
    )!;

    // officialWheelStatus must not fabricate availability for pending wheels.
    const status = officialWheelStatus(pending, "win32-x64");
    expect(status).toMatchObject({ status: "acquisition-pending" });
    expect(status.sha256).toBe("0".repeat(64));

    const rc1 = catalog.releases.find(
      (entry) => entry.version === "0.1.2-rc.1",
    )!;
    expect(officialWheelStatus(rc1, "win32-x64")).toMatchObject({
      status: "available",
      sha256: "390bd8cd5f8700fc609c58e1ccb78091d5c8c6e11c21656e284e0f68da0e148f",
    });
  });

  it("never selects an acquisition-pending baseline as a usable runtime", async () => {
    const catalog = await loadRuntimeLockCatalog();

    // Exact-tag capability evidence must not surface the pending entry.
    expect(
      selectRuntimeByEvidence(catalog, {
        schemaVersion: 1,
        capabilities: { capabilities: ["dsh-v0.1.3-alpha.2"] },
      }),
    ).toBeUndefined();

    // The base capability still resolves to the acquirable pinned release.
    const rc1 = selectRuntimeByEvidence(catalog, {
      schemaVersion: 1,
      capabilities: { capabilities: ["dsh"] },
    });
    expect(rc1!.officialWheel.status).toBe("available");
  });

  it("resolves the pinned release when a catalog lock is the only input", async () => {
    // loadRuntimeLock over the repository catalog (no local runtime-lock.json)
    // must keep selecting the pinned rc.1 release, including its wheel source.
    const lock = await loadRuntimeLock(
      join(repositoryRoot, "runtime-lock", "dsh-runtime.json"),
    );
    expect(lock.version).toBe("0.1.2-rc.1");
    expect(lock.source.sha256).toBe(
      "390bd8cd5f8700fc609c58e1ccb78091d5c8c6e11c21656e284e0f68da0e148f",
    );
  });

  it("verifies a catalog lock by its pinned release without runtime errors", async () => {
    // runtimeFromLock-based CLI verification over the repository catalog must
    // resolve the pinned rc.1 entry, not crash on the catalog shape.
    const lock = await loadRuntimeLock(
      join(repositoryRoot, "runtime-lock", "dsh-runtime.json"),
    );
    const spec = lock.platforms["win32-x64"];
    expect(spec.artifactState).toEqual({ status: "built" });
    expect(spec.files.length).toBeGreaterThan(0);
  });
});

type RuntimeSelectionEvidence = Parameters<
  typeof selectRuntimeByEvidence
>[1];
