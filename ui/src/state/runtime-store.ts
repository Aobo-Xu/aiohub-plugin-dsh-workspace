import { reactive } from "vue";
import type {
  CapabilityDescriptor,
  RuntimeRef,
  RuntimeState,
} from "@aiohub/dsh-runtime-facade/types";

export type RuntimeStoreState = {
  state: RuntimeState | "unknown";
  negotiated: readonly CapabilityDescriptor[];
  mutationsAvailable: boolean;
  runtime: RuntimeRef | undefined;
};

/**
 * Runtime lifecycle projection. Replaced wholesale from facade composition
 * or Host state events; holds no persistence and no mutation calls.
 */
export function createRuntimeStore() {
  const state = reactive<RuntimeStoreState>({
    state: "unknown",
    negotiated: [],
    mutationsAvailable: false,
    runtime: undefined,
  });

  function applyRuntimeInfo(info: {
    state: RuntimeState;
    negotiated: readonly CapabilityDescriptor[];
    mutationsAvailable: boolean;
    runtime?: RuntimeRef;
  }): void {
    state.state = info.state;
    state.negotiated = info.negotiated;
    state.mutationsAvailable = info.mutationsAvailable;
    state.runtime = info.runtime;
  }

  function applyRuntimeState(next: RuntimeState): void {
    state.state = next;
  }

  function reset(): void {
    state.state = "unknown";
    state.negotiated = [];
    state.mutationsAvailable = false;
    state.runtime = undefined;
  }

  return { state, applyRuntimeInfo, applyRuntimeState, reset };
}
