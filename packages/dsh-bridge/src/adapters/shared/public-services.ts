/**
 * Shared service wiring for release adapters (design doc §12 `adapters/`):
 * generic evidence-collection and capability-descriptor helpers that describe a
 * booted DSH runtime's public service settlement. Release-specific imports and
 * event mapping live in the release adapter files (`rc1.ts`, `alpha2.ts`), never
 * here.
 */
import type { CapabilityDescriptor } from "../../../../runtime-facade/src/types.js";

/**
 * Reads the public Cordis service keys present on a booted runtime context.
 * A service counts as settled only when a real value is registered for its
 * key; the caller presents this set as probe/selection evidence.
 */
export function settledServiceNames(ctx: object, candidates: readonly string[]): string[] {
  const lookup = ctx as Record<string, unknown>;
  return candidates.filter((name) => lookup[name] !== undefined && lookup[name] !== null);
}

/**
 * Builds one capability descriptor from the adapter's own operation vocabulary.
 * Availability is always derived from the settled evidence (the operation's
 * port must have proven the underlying service), never from release names.
 */
export function capability(
  capabilityId: string,
  schemaRevision: number,
  mode: CapabilityDescriptor["mode"],
  stability: CapabilityDescriptor["stability"] = "stable",
): CapabilityDescriptor {
  return { capabilityId, schemaRevision, stability, mode };
}

/**
 * Operation availability gate shared by every port: an operation is available
 * exactly when its capability id is part of the settled capability set.
 */
export function availabilityFor(
  capabilities: readonly CapabilityDescriptor[],
  operationId: string,
): { available: true } | { available: false; reason: { code: "CAPABILITY_NOT_NEGOTIATED" | "ENVIRONMENT_UNSUPPORTED" | "TEMPORARILY_UNAVAILABLE" } } {
  if (capabilities.some((descriptor) => descriptor.capabilityId === operationId)) {
    return { available: true };
  }
  return { available: false, reason: { code: "CAPABILITY_NOT_NEGOTIATED" } };
}

/**
 * Result of a settled-capability-guarded operation. Mutations must be proved
 * available before the runtime is touched; unavailable operations return
 * `unavailable` instead of improvising a bridge-level fallback.
 */
export type SettledOperation<T> =
  | { status: "ok"; value: T }
  | { status: "unavailable"; reason: { code: "CAPABILITY_NOT_NEGOTIATED" } };

export function guardOperation<T>(
  capabilities: readonly CapabilityDescriptor[],
  operationId: string,
  run: () => Promise<T> | T,
): Promise<SettledOperation<T>> | SettledOperation<T> {
  const availability = availabilityFor(capabilities, operationId);
  if (!availability.available) {
    return { status: "unavailable", reason: { code: "CAPABILITY_NOT_NEGOTIATED" } };
  }
  return run() as Promise<SettledOperation<T>> | SettledOperation<T>;
}
