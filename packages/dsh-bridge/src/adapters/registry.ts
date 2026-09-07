import type {
  CapabilityDescriptor,
} from "../../../runtime-facade/src/types.js";
import {
  ADAPTER_INCOMPATIBLE,
  type AdapterIdentity,
  type AdapterProbe,
  type AdapterSelectionEvidence,
  type DshReleaseAdapter,
} from "./types.js";

// The evidence type lives with the rest of the seam types in types.ts; it is
// re-exported here so existing import sites keep working unchanged.
export type { AdapterSelectionEvidence };

/**
 * A registered adapter factory plus the public evidence it requires. The
 * registry probes a candidate and only commits to it when the observed public
 * service settlement satisfies the declared requirement.
 */
export type AdapterFactoryRegistration = {
  factory: () => DshReleaseAdapter;
  /** Public services the release must expose for this factory to apply. */
  requiredServices?: readonly string[];
  /** Schema identity the release must report for this factory to apply. */
  schemaVersion?: number;
};

export type AdapterSelectionOutcome =
  | { status: "selected"; adapterId: string }
  | {
      status: "incompatible";
      reason: typeof ADAPTER_INCOMPATIBLE;
      detail?: string;
    };

/**
 * Minimal settled handle the composition root returns. Task 5/6 adapters
 * implement the full port surface; the host only depends on the ports and this
 * provenance identity.
 */
export type SettledAdapterHost = {
  readonly adapterIdentity: AdapterIdentity;
  capabilities(): readonly CapabilityDescriptor[];
  dispose(): Promise<void>;
};

interface Registration extends AdapterFactoryRegistration {
  factory: () => DshReleaseAdapter;
}

export interface AdapterRegistry {
  register(
    factory: () => DshReleaseAdapter,
    requirement?: Omit<AdapterFactoryRegistration, "factory">,
  ): AdapterRegistry;
  /**
   * Selects and settles an adapter for the given evidence, or records
   * `incompatible` when no factory is satisfied. A null result is fail-closed:
   * no read-only set is invented without a settled adapter proving it.
   */
  select(evidence: AdapterSelectionEvidence): Promise<SettledAdapterHost | null>;
  /** Last selection outcome for diagnostics; never a decision input. */
  readonly lastSelection: AdapterSelectionOutcome | null;
}

/** Best-effort dispose for candidates discarded mid-selection. */
async function disposeQuietly(candidate: DshReleaseAdapter): Promise<void> {
  try {
    await candidate.dispose();
  } catch {
    // A failing dispose during selection cleanup must not mask the
    // selection outcome.
  }
}

export function createAdapterRegistry(): AdapterRegistry {
  const registrations: Registration[] = [];
  let lastSelection: AdapterSelectionOutcome | null = null;

  function register(
    factory: () => DshReleaseAdapter,
    requirement?: Omit<AdapterFactoryRegistration, "factory">,
  ): AdapterRegistry {
    registrations.push({ factory, ...requirement });
    return registry;
  }

  async function select(
    evidence: AdapterSelectionEvidence,
  ): Promise<SettledAdapterHost | null> {
    lastSelection = null;

    // Fail closed on malformed or version-flavoured evidence: selection is
    // driven by public service/schema evidence only.
    const evidenceValid =
      typeof evidence?.schemaVersion === "number" &&
      evidence.schemaVersion > 0 &&
      Array.isArray(evidence.services) &&
      evidence.services.length > 0;
    if (!evidenceValid) {
      lastSelection = {
        status: "incompatible",
        reason: ADAPTER_INCOMPATIBLE,
        detail: "selection evidence must carry schemaVersion and public services",
      };
      return null;
    }

    for (const registration of registrations) {
      const candidate = registration.factory();
      let probe: AdapterProbe;
      try {
        probe = await candidate.probe();
      } catch (error) {
        await disposeQuietly(candidate);
        lastSelection = {
          status: "incompatible",
          reason: ADAPTER_INCOMPATIBLE,
          detail: `probe failed for ${candidate.identity.adapterId}: ${String(error)}`,
        };
        continue;
      }
      if (!probe.ok) {
        await disposeQuietly(candidate);
        continue;
      }
      if (
        registration.schemaVersion !== undefined &&
        probe.schemaVersion !== registration.schemaVersion
      ) {
        await disposeQuietly(candidate);
        continue;
      }
      const missingServices = (registration.requiredServices ?? []).filter(
        (service) => !probe.services.includes(service),
      );
      if (missingServices.length > 0) {
        await disposeQuietly(candidate);
        continue;
      }
      if (
        registration.requiredServices !== undefined &&
        !registration.requiredServices.every((service) =>
          evidence.services.includes(service),
        )
      ) {
        await disposeQuietly(candidate);
        continue;
      }

      let settled;
      try {
        settled = await candidate.settle();
      } catch (error) {
        await disposeQuietly(candidate);
        lastSelection = {
          status: "incompatible",
          reason: ADAPTER_INCOMPATIBLE,
          detail: `settle failed for ${candidate.identity.adapterId}: ${String(error)}`,
        };
        continue;
      }
      lastSelection = { status: "selected", adapterId: candidate.identity.adapterId };
      return {
        adapterIdentity: candidate.identity,
        capabilities: () => settled.capabilities,
        dispose: () => candidate.dispose(),
      };
    }

    if (lastSelection === null || lastSelection.status !== "incompatible") {
      lastSelection = {
        status: "incompatible",
        reason: ADAPTER_INCOMPATIBLE,
        detail: "no registered adapter factory satisfied the presented evidence",
      };
    }
    return null;
  }

  const registry: AdapterRegistry = {
    register,
    select,
    get lastSelection() {
      return lastSelection;
    },
  };
  return registry;
}
