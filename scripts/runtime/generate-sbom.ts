import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

type SinglePlatformLock = {
  schemaVersion: number;
  version: string;
  source: { kind: string };
  license: string;
  contractHash: string;
};

async function readLock(path: string): Promise<{
  version: string;
  license: string;
  contractHash: string;
  sourceKind: string;
}> {
  const payload = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  if (payload.platforms !== undefined) {
    return {
      version: String(payload.version ?? ""),
      license: String(
        typeof payload.license === "object" && payload.license !== null
          ? (payload.license as { license?: { id?: string } }).license?.id
          : payload.license ?? ""
      ),
      contractHash: String(payload.contractHash ?? ""),
      sourceKind: String(
        typeof payload.source === "object" && payload.source !== null
          ? (payload.source as { kind?: string }).kind
          : ""
      ),
    };
  }
  const single = payload as SinglePlatformLock;
  return {
    version: single.version,
    license: single.license,
    contractHash: single.contractHash,
    sourceKind: single.source.kind,
  };
}

function usage(): string {
  return [
    "Usage: node --experimental-strip-types scripts/runtime/generate-sbom.ts --lock <path> --out <path>",
    "",
    "  --lock <path>  Runtime lock JSON.",
    "  --out <path>   CycloneDX JSON output path.",
    "  --help         Show this help.",
  ].join("\n");
}

if (import.meta.main) {
  const values = parseArgs({
    args: process.argv.slice(2),
    options: {
      lock: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  }).values;

  if (values.help) {
    console.log(usage());
  } else if (!values.lock || !values.out) {
    console.error(usage());
    process.exitCode = 1;
  } else {
    const lock = await readLock(values.lock);
    const sbom = {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      metadata: {
        component: {
          type: "application",
          name: "deepseek-harness-runtime",
          version: lock.version,
          licenses: [{ license: { id: lock.license } }],
          properties: [
            { name: "aio:runtime-source", value: lock.sourceKind },
            { name: "aio:contract-hash", value: lock.contractHash },
          ],
        },
      },
      components: [
        {
          type: "framework",
          name: "deepseek-harness",
          version: lock.version,
          licenses: [{ license: { id: lock.license } }],
        },
      ],
    };
    const outputPath = resolve(values.out);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(sbom, null, 2)}\n`);
    console.log(outputPath);
  }
}
