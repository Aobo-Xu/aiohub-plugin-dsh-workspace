import type { OperationAvailability, RuntimeState } from "@aiohub/dsh-runtime-facade/types";
import { featureById } from "./feature-map";

export type ActionDisabledCode =
  | "CAPABILITY_UNAVAILABLE"
  | "RUNTIME_UNAVAILABLE"
  | "OBSERVER_READ_ONLY"
  | "TRANSFER_PENDING"
  | "STALE_GENERATION";

export type ActionAvailability =
  | { enabled: true }
  | {
      enabled: false;
      reason: { code: ActionDisabledCode; hostReasonCode?: string };
    };

export type ActionContext = {
  runtimeState: RuntimeState | "unknown";
  leaseMode?: "controller" | "observer";
  transferPending?: boolean;
  generationStale?: boolean;
  availability: (capabilityId: string) => OperationAvailability;
};

const ACTIONABLE_STATES: ReadonlySet<string> = new Set(["ready", "busy"]);

/**
 * Derives the enabled state and reason for one UI action. Selectors may
 * restrict an advertised action but must never synthesize one: anything the
 * Host did not negotiate stays disabled.
 */
export function getActionAvailability(
  context: ActionContext,
  featureId: string,
): ActionAvailability {
  const feature = featureById(featureId);
  if (feature === undefined) {
    return disabled("CAPABILITY_UNAVAILABLE");
  }

  const availability = context.availability(feature.capabilityId);
  if (!availability.available) {
    return disabled("CAPABILITY_UNAVAILABLE", availability.reason?.code);
  }

  if (!ACTIONABLE_STATES.has(context.runtimeState)) {
    return disabled("RUNTIME_UNAVAILABLE");
  }

  if (context.generationStale === true) {
    return disabled("STALE_GENERATION");
  }

  if (feature.mode === "mutate") {
    if (context.transferPending === true) {
      return disabled("TRANSFER_PENDING");
    }
    if (context.leaseMode !== "controller") {
      return disabled("OBSERVER_READ_ONLY");
    }
  }

  return { enabled: true };
}

function disabled(code: ActionDisabledCode, hostReasonCode?: string): ActionAvailability {
  return {
    enabled: false,
    reason: hostReasonCode === undefined ? { code } : { code, hostReasonCode },
  };
}
