import type { CapabilityDescriptor } from "./types.js";

export const CAPABILITY_NOT_NEGOTIATED = "CAPABILITY_NOT_NEGOTIATED";

export type AvailabilityQuery =
  | { available: true }
  | {
      available: false;
      reason: { code: typeof CAPABILITY_NOT_NEGOTIATED };
    };

/**
 * Contract catalog of typed operations: command kind -> capability that must
 * be negotiated before the operation is available. Mirrors the Rust
 * `capability_catalog()` in crates/protocol; `session.archive` stays
 * experimental and requires a capability of its own that is never negotiated
 * in this contract revision.
 */
const OPERATION_CAPABILITY: Readonly<Record<string, string>> = Object.freeze({
  "session.acquire": "session",
  "session.transfer-controller": "session",
  "session.submit-prompt": "session",
  "session.cancel": "session",
  "session.steer": "session",
  "session.snapshot": "session",
  "session.archive": "session.archive",
});

const CATALOG: readonly CapabilityDescriptor[] = Object.freeze([
  {
    capabilityId: "session.acquire",
    schemaRevision: 1,
    stability: "stable",
    mode: "mutate",
  },
  {
    capabilityId: "session.transfer-controller",
    schemaRevision: 1,
    stability: "stable",
    mode: "mutate",
  },
  {
    capabilityId: "session.submit-prompt",
    schemaRevision: 1,
    stability: "stable",
    mode: "mutate",
  },
  {
    capabilityId: "session.cancel",
    schemaRevision: 1,
    stability: "stable",
    mode: "mutate",
  },
  {
    capabilityId: "session.steer",
    schemaRevision: 1,
    stability: "stable",
    mode: "mutate",
  },
  {
    capabilityId: "session.snapshot",
    schemaRevision: 1,
    stability: "stable",
    mode: "read",
  },
]);

/**
 * Bounded availability state for one runtime connection. Fail-closed by
 * default: before a successful negotiation every catalog operation reports
 * `CAPABILITY_NOT_NEGOTIATED`.
 */
export class AvailabilityTracker {
  private readonly negotiated = new Set<string>();

  public applyNegotiation(capabilities: readonly string[]): void {
    this.negotiated.clear();
    for (const capability of capabilities) {
      this.negotiated.add(capability);
    }
  }

  public capabilities(): readonly CapabilityDescriptor[] {
    return CATALOG.filter((descriptor) =>
      this.negotiated.has(OPERATION_CAPABILITY[descriptor.capabilityId])
    );
  }

  public availability(capabilityId: string): AvailabilityQuery {
    const required = OPERATION_CAPABILITY[capabilityId];
    if (required === undefined || !this.negotiated.has(required)) {
      return {
        available: false,
        reason: { code: CAPABILITY_NOT_NEGOTIATED },
      };
    }
    return { available: true };
  }
}

export function commandCapabilityId(commandKind: string): string | undefined {
  return commandKind in OPERATION_CAPABILITY ? commandKind : undefined;
}
