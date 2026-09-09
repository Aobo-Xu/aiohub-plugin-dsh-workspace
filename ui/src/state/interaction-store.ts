import { reactive } from "vue";
import type {
  InteractionRequest,
  InteractionResolved,
} from "@aiohub/dsh-runtime-facade/types";

export type InteractionStoreState = {
  pending: Record<string, InteractionRequest>;
  resolved: Record<string, InteractionResolved>;
};

export type ResolveDecision = "resolved" | "duplicate";

/**
 * Approval/question interactions keyed by Host correlation identity. One
 * interaction converges to exactly one resolution; duplicate responses
 * (local retry, resolution elsewhere) never overwrite the first.
 */
export function createInteractionStore() {
  const state = reactive<InteractionStoreState>({ pending: {}, resolved: {} });

  function upsert(request: InteractionRequest): void {
    if (state.resolved[request.correlationId] !== undefined) {
      return;
    }
    state.pending[request.correlationId] = request;
  }

  function resolve(resolved: InteractionResolved): ResolveDecision {
    if (state.resolved[resolved.correlationId] !== undefined) {
      return "duplicate";
    }
    state.resolved[resolved.correlationId] = resolved;
    delete state.pending[resolved.correlationId];
    return "resolved";
  }

  function clear(): void {
    state.pending = {};
    state.resolved = {};
  }

  return { state, upsert, resolve, clear };
}
