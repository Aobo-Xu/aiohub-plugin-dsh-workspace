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
  "workspace.list": "workspace.follow",
  "workspace.open": "workspace.follow",
  "workspace.create": "workspace.create",
  "workspace.rename": "workspace.rename",
  "workspace.remove": "workspace.delete",
  "workspace.archiveSession": "workspace.archive-session",
  "session.list": "session.list",
  "session.open": "session.open",
  "session.create": "session.create",
  "session.search": "session.search",
  "session.history": "session.history",
  "session.resume": "session.resume",
  "session.rename": "session.rename",
  "session.restoreArchive": "session.restore-archive",
  "session.delete": "session.delete",
  "session.fork": "session.fork",
  "session.updateQueue": "session.update-queue",
  "session.restart": "session.restart",
  "terminal.open": "terminal.open",
  "terminal.read": "terminal.read",
  "terminal.list": "terminal.open",
  "terminal.input": "terminal.send",
  "terminal.resize": "terminal.resize",
  "terminal.interrupt": "terminal.interrupt",
  "terminal.close": "terminal.close",
  "preset.catalog": "preset.catalog",
  "preset.select": "preset.select",
  "dynamic.host.define": "dynamic.host.define",
  "dynamic.host.run": "dynamic.host.run",
  "dynamic.host.update": "dynamic.host.update",
  "dynamic.host.stop": "dynamic.host.stop",
  "dynamic.host.undefine": "dynamic.host.undefine",
  "dynamic.host.inventory": "dynamic.host.inventory",
  "dynamic.host.diagnostics": "dynamic.host.diagnostics",
  "attachment.limits": "attachment.limits",
  "context.summary": "session.snapshot",
});

const BASE_CATALOG: readonly CapabilityDescriptor[] = [
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
];

const READ_OPERATIONS = new Set([
  "workspace.list", "workspace.open", "session.list", "session.open",
  "session.search", "session.history", "terminal.read", "terminal.list",
  "preset.catalog", "dynamic.host.inventory", "dynamic.host.diagnostics",
  "attachment.limits", "context.summary",
]);

const CATALOG: readonly CapabilityDescriptor[] = Object.freeze([
  ...BASE_CATALOG,
  ...Object.keys(OPERATION_CAPABILITY)
    .filter((capabilityId) => !BASE_CATALOG.some((item) => item.capabilityId === capabilityId))
    .map((capabilityId) => ({
      capabilityId,
      schemaRevision: 1,
      stability: "stable" as const,
      mode: READ_OPERATIONS.has(capabilityId) ? "read" as const : "mutate" as const,
    })),
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
