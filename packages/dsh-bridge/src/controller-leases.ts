import type {
  AcquireSessionInput,
  ControllerLease,
  RuntimeRef,
  TransferControllerInput,
} from "../../runtime-facade/src/types.js";

export class BridgeCommandError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(code);
    this.name = "BridgeCommandError";
    this.code = code;
  }
}

type LeaseState = {
  contractHash: string;
  controller?: ControllerLease;
  domainGenerationId: string;
  leaseCounter: number;
  sessionId: string;
};

export interface ControllerLeaseService {
  acquire(input: AcquireSessionInput): Promise<ControllerLease>;
  assertMutable(lease: ControllerLease): void;
  release(lease: ControllerLease): Promise<void>;
  transfer(input: TransferControllerInput): Promise<ControllerLease>;
}

export function createControllerLeaseService(): ControllerLeaseService {
  const sessions = new Map<string, LeaseState>();

  return {
    async acquire(input) {
      validateRuntimeRef(input);
      validateSessionId(input.sessionId);
      validateViewId(input.viewId);

      const state = getOrCreateState(sessions, input);
      if (input.requestedMode === "controller") {
        if (state.controller) {
          throw new BridgeCommandError("CONTROLLER_ALREADY_HELD");
        }
        state.controller = createLease(state, "controller");
        return { ...state.controller };
      }

      return createLease(state, "observer");
    },

    assertMutable(lease) {
      validateRuntimeRef(lease);
      validateSessionId(lease.sessionId);

      const state = sessions.get(lease.sessionId);
      if (!state) {
        throw new BridgeCommandError("UNKNOWN_SESSION");
      }

      if (lease.domainGenerationId !== state.domainGenerationId) {
        throw new BridgeCommandError("STALE_GENERATION");
      }

      if (lease.contractHash !== state.contractHash) {
        throw new BridgeCommandError("CONTRACT_HASH_MISMATCH");
      }

      if (lease.mode === "observer") {
        throw new BridgeCommandError("OBSERVER_MUTATION");
      }

      if (!state.controller || state.controller.leaseId !== lease.leaseId) {
        throw new BridgeCommandError("STALE_LEASE");
      }
    },

    async release(lease) {
      this.assertMutable(lease);
      const state = sessions.get(lease.sessionId);
      if (state) {
        state.controller = undefined;
      }
    },

    async transfer(input) {
      validateRuntimeRef(input);
      validateSessionId(input.sessionId);
      validateViewId(input.targetViewId);
      this.assertMutable(input);

      const state = sessions.get(input.sessionId);
      if (!state) {
        throw new BridgeCommandError("UNKNOWN_SESSION");
      }

      state.controller = createLease(state, "controller");
      return { ...state.controller };
    },
  };
}

function getOrCreateState(
  sessions: Map<string, LeaseState>,
  input: AcquireSessionInput,
): LeaseState {
  const existing = sessions.get(input.sessionId);
  if (existing) {
    if (existing.domainGenerationId !== input.domainGenerationId) {
      existing.domainGenerationId = input.domainGenerationId;
      existing.controller = undefined;
    }
    return existing;
  }

  const state: LeaseState = {
    contractHash: input.contractHash,
    controller: undefined,
    domainGenerationId: input.domainGenerationId,
    leaseCounter: 0,
    sessionId: input.sessionId,
  };
  sessions.set(input.sessionId, state);
  return state;
}

function createLease(
  state: LeaseState,
  mode: ControllerLease["mode"],
): ControllerLease {
  state.leaseCounter += 1;
  return {
    contractHash: state.contractHash,
    domainGenerationId: state.domainGenerationId,
    leaseId: `lease-${state.leaseCounter}`,
    mode,
    sessionId: state.sessionId,
  };
}

function validateRuntimeRef(value: RuntimeRef): void {
  if (typeof value.domainGenerationId !== "string" || value.domainGenerationId.length === 0) {
    throw new BridgeCommandError("INVALID_DOMAIN_GENERATION_ID");
  }

  if (typeof value.contractHash !== "string" || value.contractHash.length === 0) {
    throw new BridgeCommandError("INVALID_CONTRACT_HASH");
  }
}

function validateSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new BridgeCommandError("INVALID_SESSION_ID");
  }
}

function validateViewId(viewId: string): void {
  if (typeof viewId !== "string" || viewId.length === 0) {
    throw new BridgeCommandError("INVALID_VIEW_ID");
  }
}

