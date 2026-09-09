import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeProductionFacade,
  REQUIRED_READ_CAPABILITIES,
  WORKSTATION_PLUGIN_ID,
} from "../../src/facade/compose-production";
import { FacadeCompositionError } from "../../src/facade/errors";
import {
  FakePluginProxy,
  TEST_CONTRACT_HASH,
  defaultInitializeResult,
} from "../adapters/fake-runtime-facade";

const READ_ONLY_NEGOTIATED = [
  "session",
  "workspace.follow",
  "session.list",
  "session.open",
  "session.history",
  "session.search",
];

const FULL_NEGOTIATED = [
  ...READ_ONLY_NEGOTIATED,
  "workspace.create",
  "session.create",
  "session.cancel",
  "session.submit-prompt",
];

function composeWith(proxy: unknown, extra: Record<string, unknown> = {}) {
  return composeProductionFacade({
    getActivePlugin: () => proxy,
    expectedContractHash: TEST_CONTRACT_HASH,
    ...extra,
  });
}

describe("composeProductionFacade", () => {
  it("fails closed when the plugin is missing, disabled or broken", async () => {
    for (const proxy of [undefined, null]) {
      const error = await composeWith(proxy).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FacadeCompositionError);
      expect((error as FacadeCompositionError).code).toBe("PLUGIN_NOT_ACTIVE");
    }
  });

  it("fails closed when the proxy does not expose the sidecar method surface", async () => {
    const proxy = new FakePluginProxy();
    const broken: Record<string, unknown> = { ...proxy };
    for (const key of Reflect.ownKeys(FakePluginProxy.prototype)) {
      if (key !== "constructor") broken[key as string] = Reflect.get(proxy, key);
    }
    delete broken.command;

    const error = await composeWith(broken).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FacadeCompositionError);
    expect((error as FacadeCompositionError).code).toBe("PLUGIN_PROXY_INVALID");
  });

  it("propagates initialize failure as INITIALIZE_FAILED with the original cause", async () => {
    const cause = new Error("sidecar refused");
    const proxy = new FakePluginProxy({ initializeError: cause });

    const error = await composeWith(proxy).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FacadeCompositionError);
    expect((error as FacadeCompositionError).code).toBe("INITIALIZE_FAILED");
    expect((error as FacadeCompositionError).cause).toBe(cause);
  });

  it("rejects an incompatible negotiated contract identity", async () => {
    const proxy = new FakePluginProxy({ contractHash: "other-hash" });

    const error = await composeWith(proxy).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FacadeCompositionError);
    expect((error as FacadeCompositionError).code).toBe("CONTRACT_MISMATCH");
  });

  it("fails closed when a required read capability was not negotiated", async () => {
    const proxy = new FakePluginProxy({
      capabilities: FULL_NEGOTIATED.filter((id) => id !== "session.history"),
    });

    const error = await composeWith(proxy).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FacadeCompositionError);
    expect((error as FacadeCompositionError).code).toBe("REQUIRED_CAPABILITY_MISSING");
    expect((error as FacadeCompositionError).missingCapabilities).toEqual([
      "session.history",
    ]);
  });

  it("composes a read-only partial facade when mutate capabilities are absent", async () => {
    const proxy = new FakePluginProxy({ capabilities: READ_ONLY_NEGOTIATED });

    const result = await composeWith(proxy);
    expect(result.mutationsAvailable).toBe(false);
    expect(result.state).toBe("ready");
    for (const capabilityId of REQUIRED_READ_CAPABILITIES) {
      expect(result.facade.availability(capabilityId).available).toBe(true);
    }
  });

  it("composes the production facade for a compatible Host and records defaults", async () => {
    const proxy = new FakePluginProxy({ capabilities: FULL_NEGOTIATED });

    const result = await composeWith(proxy, { pluginId: WORKSTATION_PLUGIN_ID });
    expect(result.mutationsAvailable).toBe(true);
    expect(result.runtime.contractHash).toBe(TEST_CONTRACT_HASH);
    expect(result.negotiated.length).toBeGreaterThan(0);

    const initializeCall = proxy.calls.find((call) => call.method === "initialize");
    expect(initializeCall?.params).toMatchObject({
      hostApiVersion: 3,
      platform: "win32-x64",
      prewarm: false,
    });
  });

  it("never imports test adapters from production facade sources", () => {
    const facadeDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src/facade",
    );
    const stack = [facadeDir];
    const files: string[] = [];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) stack.push(full);
        else if (entry.endsWith(".ts")) files.push(full);
      }
    }
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(/tests\/adapters|fake-runtime-facade|deepseek-harness|cordis/.test(text)).toBe(false);
    }
  });

  it("uses the scripted initialize result for snapshot validation downstream", async () => {
    const proxy = new FakePluginProxy({ capabilities: FULL_NEGOTIATED });
    const result = await composeWith(proxy);
    const snapshot = await result.facade.snapshot("session-1");
    expect(snapshot.source).toBe("dsh");
    expect(defaultInitializeResult().contractHash).toBe(TEST_CONTRACT_HASH);
  });
});
