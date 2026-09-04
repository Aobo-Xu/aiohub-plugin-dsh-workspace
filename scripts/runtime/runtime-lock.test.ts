import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  loadRuntimeLock,
  officialWheelStatus,
  resolveRuntime,
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
    const current = JSON.parse(
      await readFile(join(repositoryRoot, "runtime-lock", "dsh-runtime.json"), "utf8"),
    );
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
