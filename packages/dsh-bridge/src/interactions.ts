import { BridgeCommandError } from "./controller-leases.js";
import type {
  ControllerLease,
  InteractionRequest,
  InteractionResolved,
  RuntimeRef,
} from "../../runtime-facade/src/types.js";

export type InteractionDecision = {
  kind: "allow-once" | "deny" | "answer" | "cancel" | "timeout";
  answer?: string;
};

export type InteractionResolveRef = RuntimeRef & {
  sessionId: string;
  leaseId: string;
  correlationId: string;
};

type InteractionEntry = {
  request: InteractionRequest;
  resolved?: InteractionResolved;
};

export interface InteractionService {
  open(request: InteractionRequest): void;
  resolveGeneration(
    domainGenerationId: string,
    reason: InteractionResolved["reason"],
  ): readonly InteractionResolved[];
  resolveOnce(
    ref: InteractionResolveRef & Pick<ControllerLease, "mode">,
    decision: InteractionDecision,
  ): Promise<void>;
}

export function createInteractionService(options: {
  assertMutable: (lease: ControllerLease) => void;
}): InteractionService {
  const entries = new Map<string, InteractionEntry>();

  return {
    open(request) {
      validateRequest(request);
      if (entries.has(request.correlationId)) {
        throw new BridgeCommandError("INTERACTION_ALREADY_OPEN");
      }

      entries.set(request.correlationId, { request });
    },

    resolveGeneration(domainGenerationId, reason) {
      const resolved: InteractionResolved[] = [];
      for (const [correlationId, entry] of entries) {
        if (
          entry.request.domainGenerationId === domainGenerationId &&
          !entry.resolved
        ) {
          entry.resolved = createResolved(entry.request, reason);
          resolved.push(entry.resolved);
        }
        if (entry.resolved) {
          entries.set(correlationId, entry);
        }
      }
      return resolved;
    },

    async resolveOnce(ref, decision) {
      options.assertMutable(ref);
      validateDecision(decision);

      const entry = entries.get(ref.correlationId);
      if (!entry) {
        throw new BridgeCommandError("UNKNOWN_INTERACTION");
      }

      if (entry.request.sessionId !== ref.sessionId) {
        throw new BridgeCommandError("SESSION_MISMATCH");
      }

      if (entry.request.domainGenerationId !== ref.domainGenerationId) {
        throw new BridgeCommandError("STALE_GENERATION");
      }

      if (entry.resolved) {
        throw new BridgeCommandError("INTERACTION_RESOLVED");
      }

      entry.resolved = createResolved(entry.request, decisionToReason(decision));
    },
  };
}

function createResolved(
  request: InteractionRequest,
  reason: InteractionResolved["reason"],
): InteractionResolved {
  return {
    contractHash: request.contractHash,
    correlationId: request.correlationId,
    domainGenerationId: request.domainGenerationId,
    reason,
    sessionId: request.sessionId,
  };
}

function decisionToReason(
  decision: InteractionDecision,
): InteractionResolved["reason"] {
  switch (decision.kind) {
    case "cancel":
      return "cancelled";
    case "timeout":
      return "timeout";
    case "answer":
    case "allow-once":
    case "deny":
      return "answered";
  }
}

function validateRequest(request: InteractionRequest): void {
  if (typeof request.sessionId !== "string" || request.sessionId.length === 0) {
    throw new BridgeCommandError("INVALID_SESSION_ID");
  }

  if (
    typeof request.correlationId !== "string" ||
    request.correlationId.length === 0
  ) {
    throw new BridgeCommandError("INVALID_CORRELATION_ID");
  }

  if (request.kind !== "approval" && request.kind !== "question") {
    throw new BridgeCommandError("INVALID_INTERACTION_KIND");
  }

  if (
    typeof request.domainGenerationId !== "string" ||
    request.domainGenerationId.length === 0
  ) {
    throw new BridgeCommandError("INVALID_DOMAIN_GENERATION_ID");
  }

  if (typeof request.contractHash !== "string" || request.contractHash.length === 0) {
    throw new BridgeCommandError("INVALID_CONTRACT_HASH");
  }
}

function validateDecision(decision: InteractionDecision): void {
  const validKinds = new Set([
    "allow-once",
    "deny",
    "answer",
    "cancel",
    "timeout",
  ]);

  if (!validKinds.has(decision.kind)) {
    throw new BridgeCommandError("INVALID_INTERACTION_DECISION");
  }

  if (decision.kind === "answer" && typeof decision.answer !== "string") {
    throw new BridgeCommandError("INVALID_INTERACTION_ANSWER");
  }
}
