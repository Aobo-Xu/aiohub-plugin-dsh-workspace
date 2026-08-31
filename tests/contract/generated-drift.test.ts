import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const schemaPath = fileURLToPath(
  new URL("../../generated/protocol.schema.json", import.meta.url),
);
const declarationsPath = fileURLToPath(
  new URL("../../generated/protocol.d.ts", import.meta.url),
);

function runGeneratedCheck() {
  return spawnSync(
    "cargo",
    ["run", "-p", "aio-dsh-protocol", "--bin", "generate", "--", "--check"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );
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
    expect(declarations).toContain("protocolVersion:");
    expect(declarations).toContain("contractHash:");
    expect(declarations).toContain("kind: \"initialize\"");
    expect(declarations).toContain("data: InitializeRequest");
  });

  test("check mode accepts current generated artifacts", () => {
    const result = runGeneratedCheck();
    expect(result.status, result.stderr).toBe(0);
  });

  test("check mode reports drift without modifying the artifact", () => {
    const original = readFileSync(declarationsPath, "utf8");
    const drifted = `${original}// intentional contract drift\n`;
    writeFileSync(declarationsPath, drifted, "utf8");

    try {
      const result = runGeneratedCheck();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("generated protocol drift");
      expect(readFileSync(declarationsPath, "utf8")).toBe(drifted);
    } finally {
      writeFileSync(declarationsPath, original, "utf8");
    }
  });
});
