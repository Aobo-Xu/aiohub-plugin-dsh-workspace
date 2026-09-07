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

export const PRODUCTION_ROOTS = [
  "packages/dsh-bridge/src",
  "packages/runtime-facade/src",
] as const;

const ALLOWED_EXTERNAL_IMPORT_PREFIXES = [
  "node:",
  "../../runtime-facade/src/",
  "../runtime-facade/src/",
] as const;

export const FORBIDDEN_IMPORT_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  label: string;
}> = [
  {
    // DSH private package surface (Web BFF, private registries, internals).
    // Separators between the root and the forbidden token may be "/", "-",
    // "_" or a quote; "dsh/src/…" relative internals are covered too.
    pattern: /(?:^|[/'"])(?:dsh|deepseek[_-]harness)(?:[/'"_-]+)(?:web[-_]?bff|private|internal|registry|(?:src[/_-])?internal)[\w/-]*/i,
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

export const FORBIDDEN_CONTENT_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  label: string;
}> = [
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

export type BoundaryViolation = {
  file: string;
  line: number;
  label: string;
  text: string;
};

function lineOf(content: string, offset: number): number {
  return content.slice(0, offset).split(/\r?\n/).length;
}

/**
 * Scans one production source file's content. Exported so the guard can
 * self-check against synthetic violation fixtures; a regex regression then
 * fails loudly instead of silently letting real violations through.
 */
export function scanSourceContent(
  file: string,
  content: string,
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
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
      // Private-path, Web BFF, and JSONL parser/mutator naming is forbidden
      // anywhere in production source, not only in imports.
      if (pattern.test(line)) {
        violations.push({
          file,
          line: index + 1,
          label,
          text: line.trim(),
        });
      }
    }
  });
  return violations;
}

async function scanProductionSources(): Promise<BoundaryViolation[]> {
  const violations: BoundaryViolation[] = [];
  for (const root of PRODUCTION_ROOTS) {
    const files = await listProductionFiles(root);
    for (const file of files) {
      const content = await readFile(join(repositoryRoot, file), "utf8");
      violations.push(...scanSourceContent(file, content));
    }
  }
  return violations;
}

/**
 * One synthetic fixture per rejected class. Each fixture must be flagged by
 * the scanner (see "the guard detects every rejected class"); the production
 * scan asserting zero violations only stays meaningful while these hold.
 */
const GUARD_SELF_CHECK_FIXTURES: ReadonlyArray<{
  name: string;
  expectedLabel: RegExp;
  source: string;
}> = [
  {
    name: "DSH private path import (dsh-internal)",
    expectedLabel: /DSH private path import/,
    source: `import { inner } from "dsh-internal/registry";\n`,
  },
  {
    name: "DSH private path import (dsh_private)",
    expectedLabel: /DSH private path import/,
    source: `import { store } from "dsh_private/store.js";\n`,
  },
  {
    name: "DSH private path import (dsh/registry)",
    expectedLabel: /DSH private path import/,
    source: `import { reg } from "dsh/registry/core.js";\n`,
  },
  {
    name: "DSH private path import (deepseek-harness-registry)",
    expectedLabel: /DSH private path import/,
    source: `import { core } from "deepseek-harness-registry/core";\n`,
  },
  {
    name: "DSH private path import (deepseek_harness/web_bff)",
    expectedLabel: /DSH private path import/,
    source: `import { bff } from "deepseek_harness/web_bff";\n`,
  },
  {
    name: "DSH private relative path (../../dsh/src/internal)",
    expectedLabel: /DSH private path import/,
    source: `import { secret } from "../../dsh/src/internal/session.js";\n`,
  },
  {
    name: "Web BFF module",
    expectedLabel: /Web BFF module/,
    source: `import { handler } from "./web-bff/handler.js";\n`,
  },
  {
    name: "JSONL parser",
    expectedLabel: /JSONL parser\/mutator/,
    source: `import { parse } from "./jsonl-parser.js";\n`,
  },
  {
    name: "JSONL mutator",
    expectedLabel: /JSONL parser\/mutator/,
    source: `const mutateLine = createNdjsonMutator();\n`,
  },
  {
    name: "machine absolute path (Windows drive)",
    expectedLabel: /machine absolute path \(drive letter\)/,
    source: `const runtimeRoot = "E:\\\\workspaces\\\\dsh-runtime";\n`,
  },
  {
    name: "machine absolute path (POSIX home)",
    expectedLabel: /machine absolute path \(POSIX home\)/,
    source: `const checkout = "/home/dev/deepseek-harness";\n`,
  },
];

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

  it("the guard detects every rejected class (self-check fixtures)", () => {
    for (const fixture of GUARD_SELF_CHECK_FIXTURES) {
      const violations = scanSourceContent("synthetic-fixture.ts", fixture.source);
      expect(
        violations.some((violation) =>
          fixture.expectedLabel.test(violation.label),
        ),
        `guard missed fixture "${fixture.name}": ${JSON.stringify(violations)}`,
      ).toBe(true);
    }
  });

  it("the guard ignores benign specifiers and relative paths", () => {
    const benignSource = [
      `import { createDshHost } from "./host/create-host.js";`,
      `import type { ControllerLease } from "../../runtime-facade/src/types.js";`,
      `import { readFile } from "node:fs/promises";`,
      `const wheelName = "deepseek_harness_runtime_bin-0.1.2rc1-py3-none-win_amd64.whl";`,
      `const runtimeSubdir = join("deepseek_harness_runtime", "runtime");`,
    ].join("\n");

    expect(scanSourceContent("benign.ts", benignSource)).toEqual([]);
  });
});
