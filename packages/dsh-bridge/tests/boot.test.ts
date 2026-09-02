import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assertPublicServices,
  BridgeNotImplementedError,
  BridgeStartupError,
  createCredentialProvider,
  createPolicy,
  createProfileAdapter,
  REQUIRED_SERVICES,
} from "../src/index.js";

const PROFILE_PATCH_URL = new URL(
  "../../../profiles/aio-coding/cordis.patch.yml",
  import.meta.url,
);
const PROFILE_PATCH_PATH = fileURLToPath(PROFILE_PATCH_URL);

type PatchRow = {
  id?: unknown;
  disabled?: unknown;
  insert?: unknown;
};

function parseProfilePatch(): PatchRow[] {
  const source = readFileSync(PROFILE_PATCH_PATH, "utf8");
  const result = spawnSync(
    "bun",
    [
      "-e",
      'let data = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { data += chunk; }); process.stdin.on("end", () => process.stdout.write(JSON.stringify(Bun.YAML.parse(data))));',
    ],
    { input: source, encoding: "utf8" },
  );

  if (result.status !== 0 || !result.stdout) {
    throw new Error(result.stderr || "bun failed to parse the profile patch");
  }
  return JSON.parse(result.stdout) as PatchRow[];
}

describe("dsh-bridge public service contract", () => {
  it("reports every missing public service when the context is empty", () => {
    let failure: unknown;
    try {
      assertPublicServices({});
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(BridgeStartupError);
    expect((failure as BridgeStartupError).code).toBe("MISSING_PUBLIC_SERVICES");
    expect((failure as BridgeStartupError).details.missing).toEqual([
      "gateway",
      "session",
      "workspace",
      "settings",
      "credentials",
      "systemPrompt",
    ]);
  });

  it("accepts a context that provides all six public services", () => {
    const context: Record<string, unknown> = {};
    for (const name of REQUIRED_SERVICES) context[name] = {};

    expect(() => assertPublicServices(context)).not.toThrow();
  });

  it("keeps the frozen six service names stable", () => {
    expect(REQUIRED_SERVICES).toEqual([
      "gateway",
      "session",
      "workspace",
      "settings",
      "credentials",
      "systemPrompt",
    ]);
  });

  it("rejects null and primitive service values", () => {
    for (const value of [null, 0, "", false]) {
      const context: Record<string, unknown> = {};
      for (const name of REQUIRED_SERVICES) context[name] = value;

      let failure: unknown;
      try {
        assertPublicServices(context);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(BridgeStartupError);
      expect((failure as BridgeStartupError).code).toBe("INVALID_PUBLIC_SERVICES");
      expect((failure as BridgeStartupError).details.invalid).toEqual([...REQUIRED_SERVICES]);
    }
  });
});

describe("aio-coding profile composition", () => {
  it("parses the profile patch as a top-level patch entry list", () => {
    const rows = parseProfilePatch();

    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("explicitly disables session-telemetry-otel", () => {
    const rows = parseProfilePatch();

    expect(
      rows.some((row) => row.id === "session-telemetry-otel" && row.disabled === true),
    ).toBe(true);
  });

  it("stages the public bridge attach point additively", () => {
    const rows = parseProfilePatch();

    const inserts = rows.flatMap((row) =>
      Array.isArray(row.insert) ? (row.insert as PatchRow[]) : [],
    );
    expect(inserts.some((row) => row.id === "aiohub-dsh-bridge")).toBe(true);
  });

  it("declares the bridge as a profile dependency", () => {
    const profile = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../profiles/aio-coding/package.json", import.meta.url)),
        "utf8",
      ),
    ) as { dependencies?: Record<string, string> };

    expect(profile.dependencies?.["@aiohub/dsh-bridge"]).toBeDefined();
  });
});

describe("dsh-bridge fail-closed stubs", () => {
  const stubs: ReadonlyArray<[string, () => unknown]> = [
    ["createPolicy", createPolicy],
  ];

  it.each(stubs)("fails closed when createPolicy is loaded early", (_name, factory) => {
    expect(factory).toThrow(BridgeNotImplementedError);
  });

  it("loads implemented model adapters without failing closed", () => {
    expect(createProfileAdapter()).toBeTypeOf("object");
    expect(
      createCredentialProvider({
        mirror: {
          replace: async () => undefined,
          resolve: async () => undefined,
          describe: async () => ({ configured: false, writable: true }),
        },
      }),
    ).toBeTypeOf("object");
  });

  it("identifies the not-implemented feature on a thrown stub error", () => {
    let failure: unknown;
    try {
      createPolicy();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(BridgeNotImplementedError);
    expect((failure as BridgeNotImplementedError).code).toBe("BRIDGE_NOT_IMPLEMENTED");
    expect((failure as BridgeNotImplementedError).feature).toBe("policy");
  });
});

