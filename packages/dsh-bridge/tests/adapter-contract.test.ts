import { describe, expect, it } from "vitest";
import type {
  AdapterIdentity,
  AdapterProbe,
  DshReleaseAdapter,
  NegotiatedCapabilities,
} from "../src/adapters/types.js";
import { ADAPTER_INCOMPATIBLE } from "../src/adapters/types.js";
import { createAdapterRegistry } from "../src/adapters/registry.js";
import { createDshHost } from "../src/host/create-host.js";
import type {
  CapabilityDescriptor,
  ControllerLease,
  OperationAvailability,
} from "../../runtime-facade/src/types.js";

const runtimeRef = {
  domainGenerationId: "generation-1",
  contractHash: "contract-1",
};

const controllerLease: ControllerLease = {
  ...runtimeRef,
  sessionId: "session-1",
  leaseId: "lease-1",
  mode: "controller",
};

const READ_ONLY_SNAPSHOT_CAPABILITY: readonly CapabilityDescriptor[] = [
  {
    capabilityId: "session.snapshot",
    schemaRevision: 1,
    stability: "stable",
    mode: "read",
  },
];

/**
 * The seam contract is built on public service/schema evidence only. A fake
 * adapter proves that the host stays on the typed ports and never inspects a
 * release version to decide behaviour.
 */
function createFakeAdapter(
  overrides: Partial<DshReleaseAdapter> = {},
): DshReleaseAdapter {
  const identity: AdapterIdentity = {
    adapterId: "fake",
    releaseTag: "dsh-v9.9.9-fake",
    releaseCommit: "f".repeat(40),
    schemaVersion: 1,
    serviceEvidence: ["gateway", "session", "workspace"],
  };
  const probe: AdapterProbe = {
    ok: true,
    schemaVersion: 1,
    services: ["gateway", "session", "workspace"],
    capabilities: [...READ_ONLY_SNAPSHOT_CAPABILITY],
  };
  const settled: NegotiatedCapabilities = {
    schemaVersion: 1,
    capabilities: [...READ_ONLY_SNAPSHOT_CAPABILITY],
  };
  const port = {
    operationAvailability(_operationId: string): OperationAvailability {
      return { available: true };
    },
  };
  return {
    identity,
    probe: async () => probe,
    settle: async () => settled,
    workspaces: port,
    sessions: port,
    projections: port,
    interactions: port,
    artifacts: port,
    terminals: port,
    presets: port,
    dynamicRuntime: port,
    migrate: async () => {
      throw new Error("not used by the host seam contract");
    },
    dispose: async () => undefined,
    ...overrides,
  };
}

describe("dsh release adapter seam", () => {
  it("exposes the frozen port surface on the adapter type", () => {
    const adapter = createFakeAdapter();
    const requiredPorts = [
      "workspaces",
      "sessions",
      "projections",
      "interactions",
      "artifacts",
      "terminals",
      "presets",
      "dynamicRuntime",
    ] as const;

    for (const portName of requiredPorts) {
      expect(adapter[portName], `missing port: ${portName}`).toBeDefined();
    }
    expect(typeof adapter.probe).toBe("function");
    expect(typeof adapter.settle).toBe("function");
    expect(typeof adapter.migrate).toBe("function");
    expect(typeof adapter.dispose).toBe("function");
    expect(adapter.identity.schemaVersion).toBe(1);
  });

  it("routes host availability queries through the settled capability set", async () => {
    const adapter = createFakeAdapter();
    const host = createDshHost({ adapter });

    // Fail closed before negotiation: nothing is available.
    expect(host.availability("session.snapshot")).toEqual({
      available: false,
      reason: { code: "CAPABILITY_NOT_NEGOTIATED" },
    });

    const settled = await adapter.settle();
    host.applyNegotiation(settled.capabilities);
    expect(host.availability("session.snapshot")).toEqual({ available: true });
    expect(host.availability("session.submit-prompt")).toEqual({
      available: false,
      reason: { code: "CAPABILITY_NOT_NEGOTIATED" },
    });
    expect(host.capabilities()).toEqual([
      {
        capabilityId: "session.snapshot",
        schemaRevision: 1,
        stability: "stable",
        mode: "read",
      },
    ]);
    await host.dispose();
  });

  it("exposes every host port through the seam without consulting provenance", async () => {
    const adapter = createFakeAdapter();
    const host = createDshHost({ adapter });
    const portNames = [
      "workspaces",
      "sessions",
      "projections",
      "interactions",
      "artifacts",
      "terminals",
      "presets",
      "dynamicRuntime",
    ] as const;

    for (const portName of portNames) {
      const port = host.port(portName);
      expect(port.operationAvailability("session.snapshot")).toEqual({
        available: false,
        reason: { code: "CAPABILITY_NOT_NEGOTIATED" },
      });
    }
    // Provenance is recorded, never used as a decision input.
    expect(host.adapterIdentity.adapterId).toBe("fake");
    expect(host.adapterIdentity.releaseTag).toBe("dsh-v9.9.9-fake");
    expect(host.adapterIdentity.releaseCommit).toBe("f".repeat(40));
    await host.dispose();
  });
});

describe("adapter registry selection", () => {
  it("selects a factory by public service/schema evidence and records provenance", async () => {
    const fake = createFakeAdapter();
    const registry = createAdapterRegistry().register(() => fake, {
      requiredServices: ["gateway", "session", "workspace"],
      schemaVersion: 1,
    });

    const host = await registry.select({
      schemaVersion: 1,
      services: ["gateway", "session", "workspace", "settings"],
    });

    expect(host).not.toBeNull();
    expect(host?.adapterIdentity.releaseTag).toBe("dsh-v9.9.9-fake");
    expect(host?.adapterIdentity.releaseCommit).toBe("f".repeat(40));
    // The read-only capability set is the one the adapter proved, not an
    // invented fallback.
    expect(host?.capabilities()).toEqual([...READ_ONLY_SNAPSHOT_CAPABILITY]);
  });

  it("returns incompatible when the evidence does not satisfy a factory", async () => {
    const registry = createAdapterRegistry().register(() => createFakeAdapter(), {
      requiredServices: ["gateway", "session", "workspace", "persistence"],
      schemaVersion: 1,
    });

    const host = await registry.select({
      schemaVersion: 1,
      services: ["gateway", "session", "workspace"],
    });

    expect(host).toBeNull();
    expect(registry.lastSelection).toMatchObject({
      status: "incompatible",
      reason: ADAPTER_INCOMPATIBLE,
    });
    expect(registry.lastSelection?.status).toBe("incompatible");
  });

  it("rejects evidence that only carries a version prefix", async () => {
    const registry = createAdapterRegistry().register(() => createFakeAdapter());

    // Version-flavoured evidence is never a valid selection input; a bare
    // version prefix must not match anything.
    const host = await registry.select({
      schemaVersion: 0,
      services: [],
    });

    expect(host).toBeNull();
    expect(registry.lastSelection).toMatchObject({
      status: "incompatible",
      reason: ADAPTER_INCOMPATIBLE,
    });
    expect(registry.lastSelection?.status).toBe("incompatible");
  });
});
