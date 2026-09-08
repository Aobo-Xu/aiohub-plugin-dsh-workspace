/**
 * Compatibility adapter for the public API exposed by dsh-v0.1.3-alpha.2.
 *
 * rc.1 remains the executable implementation baseline. The alpha.2 release
 * has no official Windows runtime wheel, so this adapter is verified against
 * immutable public-source shapes and records executable validation as pending.
 * Release provenance is never used for selection; schema and settled public
 * services are the only decision evidence.
 */
import type {
  CapabilityDescriptor,
  OperationAvailability,
} from "../../../runtime-facade/src/types.js";
import {
  createRc1Adapter,
  RC1_SERVICE_EVIDENCE,
  type Rc1RuntimeSurface,
} from "./rc1.js";
import {
  availabilityFor,
  capability,
  settledServiceNames,
} from "./shared/public-services.js";
import type {
  AdapterIdentity,
  AdapterProbe,
  DshReleaseAdapter,
  MigrationInput,
  MigrationResult,
  NegotiatedCapabilities,
} from "./types.js";

export const ALPHA2_SCHEMA_VERSION = 2;
export const ALPHA2_ADAPTER_ID = "aiohub-dsh-alpha2";

/** Public Cordis service evidence used by both the runtime probe and registry. */
export const ALPHA2_SERVICE_EVIDENCE = [...RC1_SERVICE_EVIDENCE] as const;

export const ALPHA2_IDENTITY: AdapterIdentity = {
  adapterId: ALPHA2_ADAPTER_ID,
  releaseTag: "dsh-v0.1.3-alpha.2",
  releaseCommit: "82a5fd61a7cf5c293cec4bdff68f455398d685e9",
  schemaVersion: ALPHA2_SCHEMA_VERSION,
  serviceEvidence: [...ALPHA2_SERVICE_EVIDENCE],
};

export type Alpha2CompatibilitySnapshot = {
  header: { version: number; id: string; createdAt: number };
  turnConfig: {
    persona: { prefixSource: string; suffixSource: string };
  };
  queue: ReadonlyArray<{ id: string; state: "queued" | "sending" }>;
  subagents: ReadonlyArray<{
    id: string;
    mode: "one-shot" | "continuable";
    activity: "running" | "inactive";
  }>;
  processHandles: ReadonlyArray<{
    handleId: string;
    state: "running" | "exited";
    pid?: number;
  }>;
  ptcCalls: ReadonlyArray<{ callId: string; command: string; output: unknown }>;
};

export type Alpha2RuntimeSurface = Rc1RuntimeSurface;

export type Alpha2AdapterOptions = {
  runtime: Alpha2RuntimeSurface;
  /** Supplied by runtime lock/acquisition provenance; never inferred here. */
  executableValidation?: AdapterIdentity["executableValidation"];
};

function alpha2Capabilities(
  base: readonly CapabilityDescriptor[],
): CapabilityDescriptor[] {
  const inherited = base.map((descriptor) => ({
    ...descriptor,
    schemaRevision: ALPHA2_SCHEMA_VERSION,
  }));
  return [
    ...inherited,
    capability("projection.turn-config", ALPHA2_SCHEMA_VERSION, "read"),
    capability("projection.queue", ALPHA2_SCHEMA_VERSION, "read"),
    capability("projection.subagent", ALPHA2_SCHEMA_VERSION, "read"),
    capability("projection.process", ALPHA2_SCHEMA_VERSION, "read"),
    capability("projection.ptc", ALPHA2_SCHEMA_VERSION, "read"),
  ];
}

/**
 * Creates the alpha.2 compatibility adapter. Stable controller operations are
 * delegated to the already-tested public rc.1 port wiring; only release-
 * specific schema and projection semantics live here.
 */
export function createAlpha2Adapter(
  options: Alpha2AdapterOptions,
): DshReleaseAdapter {
  const { runtime } = options;
  const base = createRc1Adapter({ runtime });
  const identity: AdapterIdentity = {
    ...ALPHA2_IDENTITY,
    serviceEvidence: [...ALPHA2_SERVICE_EVIDENCE],
    ...(options.executableValidation === undefined
      ? {}
      : { executableValidation: { ...options.executableValidation } }),
  };
  let capabilities: readonly CapabilityDescriptor[] = [];
  let disposed = false;

  function projectionAvailability(operationId: string): OperationAvailability {
    if (disposed) {
      return { available: false, reason: { code: "TEMPORARILY_UNAVAILABLE" } };
    }
    return availabilityFor(capabilities, operationId);
  }

  const projections = {
    operationAvailability: projectionAvailability,
    normalizeCompatibilitySnapshot(source: Alpha2CompatibilitySnapshot) {
      if (capabilities.length === 0) {
        throw new Error("alpha2 adapter operations require settle() first");
      }
      if (source.header.version !== ALPHA2_SCHEMA_VERSION) {
        throw new Error(
          `alpha2 compatibility snapshot requires schema ${ALPHA2_SCHEMA_VERSION}`,
        );
      }
      return {
        header: { ...source.header },
        turnConfig: {
          persona: {
            prefixSource: source.turnConfig.persona.prefixSource,
            suffixSource: source.turnConfig.persona.suffixSource,
          },
        },
        queue: source.queue.map((item) => ({
          id: item.id,
          state: item.state,
          editable: item.state !== "sending",
        })),
        subagents: source.subagents.map((subagent) => ({
          id: subagent.id,
          mode: subagent.mode,
          activity: subagent.activity,
          actions:
            subagent.mode === "continuable"
              ? (["queue", "edit", "remove", "steer", "stop"] as const)
              : ([] as const),
        })),
        // Ordinary subprocess pid was removed upstream. Construct the stable
        // handle explicitly so a fixture or future runtime cannot leak/rely on
        // a diagnostic pid. Terminal identity remains a separate DSH handle.
        processHandles: source.processHandles.map((handle) => ({
          handleId: handle.handleId,
          state: handle.state,
        })),
        ptcPresenters: source.ptcCalls.map((call) => ({
          callId: call.callId,
          detail: { command: call.command, output: call.output },
        })),
      };
    },
  };

  return {
    identity,
    async probe(): Promise<AdapterProbe> {
      if (disposed) {
        return {
          ok: false,
          schemaVersion: ALPHA2_SCHEMA_VERSION,
          services: [],
          capabilities: [],
        };
      }
      const services = settledServiceNames(runtime.ctx, ALPHA2_SERVICE_EVIDENCE);
      const ok = ALPHA2_SERVICE_EVIDENCE.every((service) =>
        services.includes(service),
      );
      if (!ok) {
        return {
          ok,
          schemaVersion: ALPHA2_SCHEMA_VERSION,
          services,
          capabilities: [],
        };
      }
      const baseProbe = await base.probe();
      return {
        ok: baseProbe.ok,
        schemaVersion: ALPHA2_SCHEMA_VERSION,
        services,
        capabilities: alpha2Capabilities(baseProbe.capabilities),
      };
    },
    async settle(): Promise<NegotiatedCapabilities> {
      const probe = await this.probe();
      if (!probe.ok) {
        throw new Error("alpha2 adapter settle failed: public service evidence incomplete");
      }
      // Settle the shared controller ports before exposing them, then retain
      // alpha.2 schema revisions at the outer stable contract.
      await base.settle();
      capabilities = probe.capabilities;
      return {
        schemaVersion: ALPHA2_SCHEMA_VERSION,
        capabilities: [...capabilities],
      };
    },
    workspaces: base.workspaces,
    sessions: base.sessions,
    projections,
    interactions: base.interactions,
    artifacts: base.artifacts,
    terminals: base.terminals,
    presets: base.presets,
    dynamicRuntime: base.dynamicRuntime,
    async migrate(input: MigrationInput): Promise<MigrationResult> {
      return base.migrate(input);
    },
    async dispose(): Promise<void> {
      disposed = true;
      capabilities = [];
      await base.dispose();
    },
  };
}

/** Register by public schema/service evidence; provenance is diagnostic only. */
export function registerAlpha2Adapter(
  registry: {
    register(
      factory: () => DshReleaseAdapter,
      requirement?: { requiredServices?: readonly string[]; schemaVersion?: number },
    ): unknown;
  },
  options: Alpha2AdapterOptions,
): unknown {
  return registry.register(() => createAlpha2Adapter(options), {
    requiredServices: [...ALPHA2_SERVICE_EVIDENCE],
    schemaVersion: ALPHA2_SCHEMA_VERSION,
  });
}
