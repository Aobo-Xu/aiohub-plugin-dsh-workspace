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

  it("exposes the adapter's real ports through the seam without consulting provenance", async () => {
    // Each fake port records the operations the host asks of it, proving the
    // host hands out the adapter's own port objects instead of synthesized
    // wrappers.
    const portCalls: string[] = [];
    const createRecordingPort = (portName: string) => ({
      operationAvailability(operationId: string): OperationAvailability {
        portCalls.push(`${portName}:${operationId}`);
        return { available: true };
      },
      [portName]: "adapter-owned-extension",
    });
    const adapter = createFakeAdapter({
      workspaces: createRecordingPort("workspaces"),
      sessions: createRecordingPort("sessions"),
      projections: createRecordingPort("projections"),
      interactions: createRecordingPort("interactions"),
      artifacts: createRecordingPort("artifacts"),
      terminals: createRecordingPort("terminals"),
      presets: createRecordingPort("presets"),
      dynamicRuntime: createRecordingPort("dynamicRuntime"),
    });
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
      // The port object is the adapter's own (extension fields survive), and
      // its real methods are the ones that run.
      expect(port[portName]).toBe("adapter-owned-extension");
      expect(port.operationAvailability("session.snapshot")).toEqual({
        available: true,
      });
    }
    expect(portCalls).toEqual([
      "workspaces:session.snapshot",
      "sessions:session.snapshot",
      "projections:session.snapshot",
      "interactions:session.snapshot",
      "artifacts:session.snapshot",
      "terminals:session.snapshot",
      "presets:session.snapshot",
      "dynamicRuntime:session.snapshot",
    ]);
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

  it("rejects malformed evidence without schemaVersion or services", async () => {
    const registry = createAdapterRegistry().register(() => createFakeAdapter());

    // Selection evidence must be well-formed public service/schema identity.
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

  it("rejects evidence that only carries a version prefix", async () => {
    const registry = createAdapterRegistry().register(() => createFakeAdapter());

    // A version prefix is never a valid selection input (the same rule as
    // selectRuntimeByEvidence): it must be ignored entirely, so the selection
    // falls back to the schema/service identity, which this evidence lacks.
    const host = await registry.select({
      schemaVersion: 0,
      services: [],
      versionPrefix: "0.1.3",
    } as unknown as Parameters<typeof registry.select>[0]);

    expect(host).toBeNull();
    expect(registry.lastSelection).toMatchObject({
      status: "incompatible",
      reason: ADAPTER_INCOMPATIBLE,
    });
    // The prefix must not be able to satisfy selection even when the public
    // evidence itself would be valid.
    const prefixOnlyRegistry = createAdapterRegistry().register(
      () => createFakeAdapter(),
    );
    const prefixOnlyHost = await prefixOnlyRegistry.select({
      schemaVersion: 1,
      services: ["gateway", "session", "workspace"],
      versionPrefix: "0.1.3",
    } as unknown as Parameters<typeof prefixOnlyRegistry.select>[0]);

    expect(prefixOnlyHost).not.toBeNull();
    // Selection succeeded on public evidence alone; the version prefix was
    // not consulted (it cannot be: the adapter never sees it).
    expect(prefixOnlyHost?.adapterIdentity.releaseTag).toBe("dsh-v9.9.9-fake");
    expect(prefixOnlyRegistry.lastSelection).toMatchObject({
      status: "selected",
      adapterId: "fake",
    });
  });

  it("disposes candidates that fail or reject during probe/settle", async () => {
    const disposed: string[] = [];
    const failingProbe = createFakeAdapter();
    failingProbe.probe = async () => {
      throw new Error("probe exploded");
    };
    const originalDispose = failingProbe.dispose.bind(failingProbe);
    failingProbe.dispose = async () => {
      disposed.push("failing-probe");
      await originalDispose();
    };

    const failingSettle = createFakeAdapter();
    failingSettle.settle = async () => {
      throw new Error("settle exploded");
    };
    const settleDispose = failingSettle.dispose.bind(failingSettle);
    failingSettle.dispose = async () => {
      disposed.push("failing-settle");
      await settleDispose();
    };

    const healthy = createFakeAdapter();
    const healthyDispose = healthy.dispose.bind(healthy);
    healthy.dispose = async () => {
      disposed.push("healthy");
      await healthyDispose();
    };

    const registry = createAdapterRegistry()
      .register(() => failingProbe)
      .register(() => failingSettle)
      .register(() => healthy, {
        requiredServices: ["gateway", "session", "workspace"],
        schemaVersion: 1,
      });

    const host = await registry.select({
      schemaVersion: 1,
      services: ["gateway", "session", "workspace"],
    });

    // The healthy adapter wins; the failed candidates were disposed and the
    // outcome is recorded instead of bubbling.
    expect(host?.adapterIdentity.adapterId).toBe("fake");
    expect(disposed).toEqual(["failing-probe", "failing-settle"]);
    expect(registry.lastSelection).toMatchObject({
      status: "selected",
      adapterId: "fake",
    });

    // A probe failure on the only candidate records incompatible without
    // throwing.
    const onlyFailing = createAdapterRegistry().register(() => {
      const adapter = createFakeAdapter();
      adapter.probe = async () => {
        throw new Error("probe exploded");
      };
      return adapter;
    });
    const none = await onlyFailing.select({
      schemaVersion: 1,
      services: ["gateway", "session", "workspace"],
    });
    expect(none).toBeNull();
    expect(onlyFailing.lastSelection).toMatchObject({
      status: "incompatible",
      reason: ADAPTER_INCOMPATIBLE,
    });
  });
});
