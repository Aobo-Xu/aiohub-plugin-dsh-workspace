import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const schemaPath = fileURLToPath(
  new URL("../../generated/protocol.schema.json", import.meta.url),
);
const declarationsPath = fileURLToPath(
  new URL("../../generated/protocol.d.ts", import.meta.url),
);
const generatedConfigPath = fileURLToPath(
  new URL("../../tsconfig.generated.json", import.meta.url),
);
const generatedFileNames = [
  "protocol.schema.json",
  "protocol.d.ts",
  "protocol.sha256",
] as const;

function makeTemporaryRoot(label: string) {
  return mkdtempSync(join(tmpdir(), `aio-dsh-protocol-${label}-`));
}

function copyGeneratedArtifacts(outputRoot: string) {
  const generatedDirectory = join(outputRoot, "generated");
  mkdirSync(generatedDirectory, { recursive: true });
  for (const fileName of generatedFileNames) {
    copyFileSync(join(repositoryRoot, "generated", fileName), join(generatedDirectory, fileName));
  }
}

function runGenerator(outputRoot: string, check: boolean) {
  const arguments_ = ["run", "-p", "aio-dsh-protocol", "--bin", "generate", "--"];
  if (check) arguments_.push("--check");
  arguments_.push("--output-root", outputRoot);
  return spawnSync(
    "cargo",
    arguments_,
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );
}

function runGeneratedTypeCheck(configPath: string) {
  return spawnSync(
    process.execPath,
    [join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"), "-p", configPath],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
}

function copyProtocolWorkspace(outputRoot: string, includeHash: boolean) {
  copyFileSync(join(repositoryRoot, "Cargo.toml"), join(outputRoot, "Cargo.toml"));
  copyFileSync(join(repositoryRoot, "Cargo.lock"), join(outputRoot, "Cargo.lock"));
  cpSync(join(repositoryRoot, "crates", "protocol"), join(outputRoot, "crates", "protocol"), {
    recursive: true,
  });
  mkdirSync(join(outputRoot, "generated"), { recursive: true });
  copyFileSync(
    join(repositoryRoot, "generated", "protocol.schema.json"),
    join(outputRoot, "generated", "protocol.schema.json"),
  );
  copyFileSync(
    join(repositoryRoot, "generated", "protocol.d.ts"),
    join(outputRoot, "generated", "protocol.d.ts"),
  );
  if (includeHash) {
    copyFileSync(
      join(repositoryRoot, "generated", "protocol.sha256"),
      join(outputRoot, "generated", "protocol.sha256"),
    );
  }
}

function runIsolatedCargo(outputRoot: string, arguments_: string[]) {
  return spawnSync("cargo", arguments_, {
    cwd: outputRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CARGO_TARGET_DIR: join(repositoryRoot, "target", "protocol-isolated-fixture"),
    },
  });
}

describe("generated protocol contract", () => {
  test("schema and declarations expose envelope and adjacent payload shapes", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      required?: string[];
      $defs?: Record<string, unknown>;
    };
    const declarations = readFileSync(declarationsPath, "utf8");

    expect(schema.required).toEqual([
      "command",
      "interaction",
      "notification",
      "response",
    ]);
    expect(Object.keys(schema.$defs ?? {})).toEqual(
      expect.arrayContaining([
        "CommandPayload",
        "ResponsePayload",
        "NotificationPayload",
        "InteractionPayload",
      ]),
    );
    for (const envelope of [
      "CommandEnvelope",
      "InteractionEnvelope",
      "NotificationEnvelope",
      "ResponseEnvelope",
    ]) {
      expect(schema.$defs?.[envelope]).toMatchObject({ type: "object" });
      expect(declarations).toContain(`export type ${envelope} = {`);
    }
    expect(Object.keys(schema.$defs ?? {})).not.toEqual(
      expect.arrayContaining(["Envelope2", "Envelope3", "Envelope4"]),
    );
    expect(declarations).not.toMatch(/Envelope\d+/);
    expect(declarations).toContain("kind: \"initialize\"");
    expect(declarations).toContain("data: InitializeRequest");
  });

  test("generated TypeScript gate rejects an invalid ambient declaration", () => {
    const outputRoot = makeTemporaryRoot("types");
    try {
      const invalidDeclaration = join(outputRoot, "invalid.d.ts");
      writeFileSync(invalidDeclaration, 'export const BROKEN = "value" as const;\n', "utf8");
      const config = JSON.parse(readFileSync(generatedConfigPath, "utf8")) as {
        files: string[];
      };
      config.files = [invalidDeclaration];
      const isolatedConfig = join(outputRoot, "tsconfig.json");
      writeFileSync(isolatedConfig, `${JSON.stringify(config, null, 2)}\n`, "utf8");

      const invalid = runGeneratedTypeCheck(isolatedConfig);
      expect(invalid.status).not.toBe(0);
      expect(`${invalid.stdout}${invalid.stderr}`).toContain("TS1254");

      const current = runGeneratedTypeCheck(generatedConfigPath);
      expect(current.status, `${current.stdout}${current.stderr}`).toBe(0);
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  test("check mode accepts an isolated copy of current artifacts", () => {
    const outputRoot = makeTemporaryRoot("check");
    try {
      copyGeneratedArtifacts(outputRoot);
      const result = runGenerator(outputRoot, true);
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  test("check mode reports isolated drift without touching tracked artifacts", () => {
    const outputRoot = makeTemporaryRoot("drift");
    const trackedBefore = generatedFileNames.map((fileName) =>
      readFileSync(join(repositoryRoot, "generated", fileName)),
    );
    try {
      copyGeneratedArtifacts(outputRoot);
      const isolatedDeclarations = join(outputRoot, "generated", "protocol.d.ts");
      const drifted = `${readFileSync(isolatedDeclarations, "utf8")}// isolated drift\n`;
      writeFileSync(isolatedDeclarations, drifted, "utf8");

      const result = runGenerator(outputRoot, true);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("generated protocol drift");
      expect(readFileSync(isolatedDeclarations, "utf8")).toBe(drifted);
      for (const [index, fileName] of generatedFileNames.entries()) {
        expect(readFileSync(join(repositoryRoot, "generated", fileName))).toEqual(
          trackedBefore[index],
        );
      }
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  test("an existing malformed contract hash fails the isolated build", () => {
    const outputRoot = makeTemporaryRoot("invalid-hash");
    try {
      copyProtocolWorkspace(outputRoot, true);
      writeFileSync(join(outputRoot, "generated", "protocol.sha256"), "invalid\n", "utf8");
      const result = runIsolatedCargo(outputRoot, ["check", "-p", "aio-dsh-protocol"]);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("invalid protocol hash");
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  test(
    "a missing contract hash can compile the generator and be rebuilt",
    () => {
      const outputRoot = makeTemporaryRoot("missing-hash");
      try {
        copyProtocolWorkspace(outputRoot, false);
        const result = runIsolatedCargo(outputRoot, [
          "run",
          "-p",
          "aio-dsh-protocol",
          "--bin",
          "generate",
          "--",
          "--output-root",
          outputRoot,
        ]);
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);

        const schema = readFileSync(join(outputRoot, "generated", "protocol.schema.json"));
        const storedHash = readFileSync(
          join(outputRoot, "generated", "protocol.sha256"),
          "utf8",
        );
        const actualHash = createHash("sha256").update(schema).digest("hex");
        expect(storedHash).toBe(actualHash);
      } finally {
        rmSync(outputRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
