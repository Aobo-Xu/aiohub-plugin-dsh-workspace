import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Normalize to POSIX separators so assertions are platform-stable. */
function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

/**
 * Static public-API boundary (design doc §13.4): production sources must not
 * reach into DSH private paths, copy the Web BFF, parse or mutate JSONL
 * envelopes, or embed machine-local absolute paths. The test scans the
 * importable production surface (package sources) — test files and docs are
 * out of scope because they quote the boundary itself.
 */

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

const PRODUCTION_ROOTS = [
  "packages/dsh-bridge/src",
  "packages/runtime-facade/src",
] as const;

const ALLOWED_EXTERNAL_IMPORT_PREFIXES = [
  "node:",
  "../../runtime-facade/src/",
  "../runtime-facade/src/",
] as const;

const FORBIDDEN_IMPORT_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  {
    // DSH private package surface (Web BFF, private registries, internals).
    pattern: /(?:^|[/'"])(?:dsh|deepseek[_-]harness)[/'"]?(?:web[-_]?bff|private|internal|registry)[\w/-]*/i,
    label: "DSH private path import",
  },
  {
    pattern: /web[-_]?bff/i,
    label: "Web BFF module",
  },
  {
    pattern: /(?:jsonl|ndjson)[\w.-]*(?:parser|parse|mutator|mutate|writer|reader|codec|stream)/i,
    label: "JSONL parser/mutator",
  },
];

const FORBIDDEN_CONTENT_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  {
    // Machine-local absolute paths: Windows drive letters and POSIX home roots.
    pattern: /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/,
    label: "machine absolute path (drive letter)",
  },
  {
    pattern: /(?:^|[^A-Za-z0-9])(?:\/home\/|\/Users\/|\/root\/)/,
    label: "machine absolute path (POSIX home)",
  },
];

async function listProductionFiles(root: string): Promise<string[]> {
  const entries = await readdir(join(repositoryRoot, root), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = toPosixPath(join(root, entry.name));
    if (entry.isDirectory()) {
      files.push(...(await listProductionFiles(entryPath)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

type Violation = { file: string; line: number; label: string; text: string };

function lineOf(content: string, offset: number): number {
  return content.slice(0, offset).split(/\r?\n/).length;
}

async function scanProductionSources(): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const root of PRODUCTION_ROOTS) {
    const files = await listProductionFiles(root);
    for (const file of files) {
      const content = await readFile(join(repositoryRoot, file), "utf8");
      // Specifiers may sit on their own line inside multi-line imports, so
      // specifiers are extracted from the whole file, not per line.
      const specifierPattern =
        /(?:\bfrom\s*|import\s*\(\s*)"([^"]+)"|\bimport\s+"([^"]+)"/g;
      for (const match of content.matchAll(specifierPattern)) {
        const specifier = match[1] ?? match[2] ?? "";
        const line = lineOf(content, match.index ?? 0);
        const external =
          !specifier.startsWith(".") &&
          !ALLOWED_EXTERNAL_IMPORT_PREFIXES.some((prefix) =>
            specifier.startsWith(prefix),
          );
        if (external) {
          violations.push({
            file,
            line,
            label: `non-whitelisted external import: ${specifier}`,
            text: specifier,
          });
        }
        for (const { pattern, label } of FORBIDDEN_IMPORT_PATTERNS) {
          if (pattern.test(specifier)) {
            violations.push({ file, line, label, text: specifier });
          }
        }
      }
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const { pattern, label } of FORBIDDEN_CONTENT_PATTERNS) {
          if (pattern.test(line)) {
            violations.push({
              file,
              line: index + 1,
              label,
              text: line.trim(),
            });
          }
        }
        for (const { pattern, label } of FORBIDDEN_IMPORT_PATTERNS) {
          // Private-path, Web BFF, and JSONL parser/mutator naming is
          // forbidden anywhere in production source, not only in imports.
          if (pattern.test(line)) {
            violations.push({ file, line: index + 1, label, text: line.trim() });
          }
        }
      });
    }
  }
  return violations;
}

describe("public API boundary", () => {
  it("keeps production sources free of DSH private paths, Web BFF, JSONL parsing, and machine absolute paths", async () => {
    const violations = await scanProductionSources();

    expect(
      violations,
      violations
        .map((violation) => `${violation.file}:${violation.line} ${violation.label}: ${violation.text}`)
        .join("\n"),
    ).toEqual([]);
  });

  it("covers the declared production roots", async () => {
    const files = (
      await Promise.all(PRODUCTION_ROOTS.map((root) => listProductionFiles(root)))
    ).flat();

    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain("packages/dsh-bridge/src/index.ts");
    expect(files).toContain("packages/dsh-bridge/src/adapters/registry.ts");
    expect(files).toContain("packages/dsh-bridge/src/host/create-host.ts");
    expect(files).toContain("packages/runtime-facade/src/runtime-facade.ts");
  });
});
