type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

type SessionEvent = {
  type?: string;
  data?: Record<string, unknown>;
};

type ApprovalRequest = {
  agent: {
    session: {
      id: string;
      seq: number;
      eventAt(seq: number): SessionEvent | undefined;
    };
  };
  toolName: string;
  callId?: string;
  reason?: string;
  signal?: AbortSignal;
};

export type PendingHostInteraction = {
  correlationId: string;
  sessionId: string;
  turnId?: string;
  kind: "approval";
  data: {
    toolName: string;
    callId?: string;
    reason?: string;
  };
};

type PendingEntry = PendingHostInteraction & {
  resolve(outcome: ApprovalOutcome): void;
  abort?: () => void;
};

export function createApprovalBroker() {
  const pending = new Map<string, PendingEntry>();
  const resolved = new Set<string>();

  function open(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const identity = identityFromAudit(request);
    if (identity === undefined || pending.has(identity.correlationId) || resolved.has(identity.correlationId)) {
      return Promise.resolve("unavailable");
    }

    return new Promise<ApprovalOutcome>((resolve) => {
      const entry: PendingEntry = {
        ...identity,
        resolve,
      };
      if (request.signal !== undefined) {
        const abort = () => settle(identity.correlationId, "cancelled");
        entry.abort = abort;
        request.signal.addEventListener("abort", abort, { once: true });
      }
      pending.set(identity.correlationId, entry);
    });
  }

  function settle(correlationId: string, outcome: ApprovalOutcome): void {
    const entry = pending.get(correlationId);
    if (entry === undefined) return;
    pending.delete(correlationId);
    resolved.add(correlationId);
    if (entry.abort !== undefined) {
      // The request signal is borrowed from DSH; remove only our listener.
      // AbortSignal.removeEventListener is safe after the signal fired.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      entry.abort = undefined;
    }
    entry.resolve(outcome);
  }

  return {
    open,
    list(sessionId: string): readonly PendingHostInteraction[] {
      return [...pending.values()]
        .filter((entry) => entry.sessionId === sessionId)
        .map(({ resolve: _resolve, abort: _abort, ...entry }) => entry);
    },
    respond(input: {
      correlationId: string;
      sessionId: string;
      decision: "allow" | "deny" | "cancel" | "timeout";
    }): { outcome: ApprovalOutcome } {
      const entry = pending.get(input.correlationId);
      if (entry === undefined) {
        if (resolved.has(input.correlationId)) throw new Error("INTERACTION_ALREADY_RESOLVED");
        throw new Error("UNKNOWN_INTERACTION");
      }
      if (entry.sessionId !== input.sessionId) throw new Error("INTERACTION_SESSION_MISMATCH");
      const outcome: ApprovalOutcome = input.decision === "allow"
        ? "allowed-once"
        : input.decision === "deny"
          ? "rejected"
          : "cancelled";
      settle(input.correlationId, outcome);
      return { outcome };
    },
    dispose(): void {
      for (const correlationId of [...pending.keys()]) settle(correlationId, "unavailable");
    },
  };
}

function identityFromAudit(request: ApprovalRequest): PendingHostInteraction | undefined {
  const { session } = request.agent;
  let correlationId: string | undefined;
  let turnId: string | undefined;
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq);
    if (correlationId === undefined && event?.type === "approval/asked") {
      const id = event.data?.id;
      if (typeof id === "string" && event.data?.toolName === request.toolName) {
        correlationId = id;
      }
    }
    if (event?.type === "turn/start") {
      const id = event.data?.turnId;
      if (typeof id === "string") turnId = id;
      break;
    }
  }
  if (correlationId === undefined) return undefined;
  return {
    correlationId,
    sessionId: session.id,
    ...(turnId === undefined ? {} : { turnId }),
    kind: "approval",
    data: {
      toolName: request.toolName,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    },
  };
}
