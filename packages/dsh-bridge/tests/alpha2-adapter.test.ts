import { describe, expect, it } from "vitest";
import {
  ALPHA2_ADAPTER_ID,
  ALPHA2_SCHEMA_VERSION,
  ALPHA2_SERVICE_EVIDENCE,
  createAlpha2Adapter,
  registerAlpha2Adapter,
} from "../src/index.js";
import { createAdapterRegistry } from "../src/adapters/registry.js";
import { createDshHost } from "../src/host/create-host.js";
import {
  ALPHA2_SOURCE_COMMIT,
  ALPHA2_SOURCE_TAG,
  createAlpha2SourceFixture,
} from "./fixtures/alpha2-runtime.js";
import type { Alpha2CompatibilitySnapshot } from "./fixtures/alpha2-runtime.js";

type Alpha2ProjectionPort = {
  operationAvailability(operationId: string): { available: boolean };
  normalizeCompatibilitySnapshot(source: Alpha2CompatibilitySnapshot): {
    turnConfig: { persona: { prefixSource: string; suffixSource: string } };
    queue: ReadonlyArray<{ id: string; state: string; editable: boolean }>;
    subagents: ReadonlyArray<{ id: string; actions: readonly string[] }>;
    processHandles: ReadonlyArray<{ handleId: string; state: string }>;
    ptcPresenters: ReadonlyArray<{ callId: string; detail: { command: string; output: unknown } }>;
  };
};

describe("alpha.2 public API compatibility adapter", () => {
  it("probes schema v2 public services without using release provenance as selection evidence", async () => {
    const fixture = createAlpha2SourceFixture();
    const adapter = createAlpha2Adapter({ runtime: fixture });

    const probe = await adapter.probe();

    expect(probe).toMatchObject({ ok: true, schemaVersion: ALPHA2_SCHEMA_VERSION });
    expect(probe.services).toEqual(expect.arrayContaining([...ALPHA2_SERVICE_EVIDENCE]));
    expect(adapter.identity).toMatchObject({
      adapterId: ALPHA2_ADAPTER_ID,
      releaseTag: ALPHA2_SOURCE_TAG,
      releaseCommit: ALPHA2_SOURCE_COMMIT,
    });
    expect(adapter.identity.executableValidation).toBeUndefined();
  });

  it("preserves alpha.2 persona, queue, subagent, process, and PTC semantics", async () => {
    const fixture = createAlpha2SourceFixture();
    const adapter = createAlpha2Adapter({ runtime: fixture });
    const host = createDshHost({ adapter });
    const settled = await adapter.settle();
    host.applyNegotiation(settled.capabilities);

    const projections = host.port("projections") as Alpha2ProjectionPort;
    const snapshot = projections.normalizeCompatibilitySnapshot(
      fixture.compatibilitySnapshot(),
    );

    expect(snapshot.turnConfig.persona).toEqual({
      prefixSource: "model-persona",
      suffixSource: "environment-context",
    });
    expect(snapshot.queue[0]).toMatchObject({ state: "sending", editable: false });
    expect(snapshot.subagents[0]?.actions).toEqual(
      expect.arrayContaining(["queue", "edit", "remove", "steer", "stop"]),
    );
    expect(snapshot.processHandles[0]).not.toHaveProperty("pid");
    expect(snapshot.ptcPresenters[0]?.detail).toMatchObject({
      command: "git status --short",
      output: " M file.ts",
    });
    await host.dispose();
  });

  it("selects alpha.2 by public schema/service evidence and keeps executable smoke pending", async () => {
    const fixture = createAlpha2SourceFixture();
    const registry = createAdapterRegistry();
    registerAlpha2Adapter(registry, {
      runtime: fixture,
      executableValidation: {
        status: "pending",
        reason: "official-wheel-unavailable",
      },
    });

    const selected = await registry.select({
      schemaVersion: ALPHA2_SCHEMA_VERSION,
      services: [...ALPHA2_SERVICE_EVIDENCE],
    });

    expect(selected?.adapterIdentity.adapterId).toBe(ALPHA2_ADAPTER_ID);
    expect(selected?.adapterIdentity.executableValidation).toEqual({
      status: "pending",
      reason: "official-wheel-unavailable",
    });
  });
});
