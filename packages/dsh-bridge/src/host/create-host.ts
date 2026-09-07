import type {
  CapabilityDescriptor,
  OperationAvailability,
} from "../../../runtime-facade/src/types.js";
import type {
  AdapterIdentity,
  AdapterPort,
  DshReleaseAdapter,
} from "../adapters/types.js";

/**
 * Stable composition root (design doc §12 `host/`): the Host depends on the
 * `DshReleaseAdapter` ports and provenance identity only. It never inspects a
 * release version, a private path, or an upstream wire detail — release
 * differences stay behind the adapter seam implemented by Task 5/6.
 */
export interface DshHost {
  readonly adapterIdentity: AdapterIdentity;
  capabilities(): readonly CapabilityDescriptor[];
  availability(operationId: string): OperationAvailability;
  /** Applies the adapter's settled capability set; fail-closed until called. */
  applyNegotiation(capabilities: readonly CapabilityDescriptor[]): void;
  port(portName: HostPortName): AdapterPort;
  dispose(): Promise<void>;
}

const HOST_PORT_NAMES = [
  "workspaces",
  "sessions",
  "projections",
  "interactions",
  "artifacts",
  "terminals",
  "presets",
  "dynamicRuntime",
] as const;

export type HostPortName = (typeof HOST_PORT_NAMES)[number];

export type CreateDshHostOptions = {
  adapter: DshReleaseAdapter;
};

export function createDshHost(options: CreateDshHostOptions): DshHost {
  const { adapter } = options;
  let settledCapabilities: readonly CapabilityDescriptor[] = [];

  function operationAvailability(operationId: string): OperationAvailability {
    // Fail closed: before the adapter settles a capability set the host
    // reports every operation unavailable.
    for (const descriptor of settledCapabilities) {
      if (descriptor.capabilityId === operationId) {
        return { available: true };
      }
    }
    return {
      available: false,
      reason: { code: "CAPABILITY_NOT_NEGOTIATED" },
    };
  }

  return {
    adapterIdentity: adapter.identity,
    capabilities: () => settledCapabilities,
    availability: operationAvailability,
    applyNegotiation(capabilities: readonly CapabilityDescriptor[]): void {
      settledCapabilities = [...capabilities];
    },
    port(portName: HostPortName): AdapterPort {
      if (!HOST_PORT_NAMES.includes(portName)) {
        throw new Error(`UNKNOWN_HOST_PORT: ${portName}`);
      }
      const port = adapter[portName] as AdapterPort;
      return {
        operationAvailability: (operationId) =>
          operationAvailability(operationId),
      };
    },
    async dispose(): Promise<void> {
      settledCapabilities = [];
      await adapter.dispose();
    },
  };
}
