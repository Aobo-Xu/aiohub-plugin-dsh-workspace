import type { ControllerLease } from "@aiohub/dsh-runtime-facade/types";

export type GateContext = {
  runtimeState: string;
  leaseMode?: "controller" | "observer";
  transferPending?: boolean;
  generationStale?: boolean;
  lease?: ControllerLease;
  turnActive: boolean;
  /** Host-advertised preference for the default busy-submit action. */
  busySubmitPreference?: "queue" | "steer";
  availability: (capabilityId: string) => { available: boolean; reason?: { code?: string } };
};

export type AttachmentDraft = { id: string; mediaType: string; bytes: number };

export type AttachmentLimits = {
  maxCount: number;
  maxBytes: number;
  mediaTypes: readonly string[];
  supportAdvertised?: boolean;
};

export type SubmitAction = "submit" | "queue" | "steer";

export type SubmitIntent = {
  text: string;
  attachments?: readonly AttachmentDraft[];
  explicitAction?: SubmitAction;
};

export type GateCommand = {
  kind: string;
  requestId?: string;
  sessionId?: string;
  leaseId?: string;
  turnId?: string;
  input?: unknown;
};

export type GateSuccess = { ok: true; action: string; command: GateCommand };

export type GateFailure = {
  ok: false;
  reason: { code: string; hostReasonCode?: string };
  /** True when the Host rejected on stale lease/generation: refresh state, never auto-retry. */
  refreshRequired?: boolean;
};

export type GateOutcome = GateSuccess | GateFailure;

export type InteractionLike = {
  correlationId: string;
  kind: "approval" | "question";
  choices: readonly string[];
  state: string;
};

export type CommandGateDeps = {
  context: () => GateContext;
  nextRequestId: () => string;
  dispatch: (command: GateCommand) => Promise<unknown>;
  attachmentLimits: () => AttachmentLimits;
};

const CAPABILITY_BY_ACTION: Readonly<Record<SubmitAction, string>> = {
  submit: "session.submit-prompt",
  queue: "session.update-queue",
  steer: "session.steer",
};

const KIND_BY_ACTION: Readonly<Record<SubmitAction, string>> = {
  submit: "session.submitPrompt",
  queue: "session.updateQueue",
  steer: "session.steer",
};

const ACTIONABLE_STATES: ReadonlySet<string> = new Set(["ready", "busy"]);
const STALE_CODES: ReadonlySet<string> = new Set(["stale-lease", "stale-generation", "unknown-lease"]);

type HostResult = { accepted?: boolean; rejection?: { code?: string } };

function fence(context: GateContext): GateFailure | undefined {
  if (context.generationStale === true) {
    return { ok: false, reason: { code: "STALE_GENERATION" }, refreshRequired: true };
  }
  if (context.transferPending === true) {
    return { ok: false, reason: { code: "TRANSFER_PENDING" } };
  }
  if (context.leaseMode !== "controller") {
    return { ok: false, reason: { code: "OBSERVER_READ_ONLY" } };
  }
  if (context.lease === undefined) {
    return { ok: false, reason: { code: "NO_LEASE" } };
  }
  if (!ACTIONABLE_STATES.has(context.runtimeState)) {
    return { ok: false, reason: { code: "RUNTIME_UNAVAILABLE" } };
  }
  return undefined;
}

/**
 * The single fenced mutation path: every command re-validates generation,
 * session, lease, capability and interaction state immediately before
 * dispatch, and Host rejections converge without automatic retries.
 */
export function createCommandGate(deps: CommandGateDeps) {
  const inFlight = new Set<string>();

  function available(capabilityId: string): boolean {
    return deps.context().availability(capabilityId).available;
  }

  function leaseFields(): { sessionId?: string; leaseId?: string } {
    const lease = deps.context().lease;
    return lease === undefined ? {} : { sessionId: lease.sessionId, leaseId: lease.leaseId };
  }

  function converge(result: unknown): GateFailure | undefined {
    const host = result as HostResult | undefined;
    if (host !== undefined && host !== null && host.accepted === false) {
      const hostReasonCode = host.rejection?.code;
      return {
        ok: false,
        reason: hostReasonCode === undefined ? { code: "HOST_REJECTED" } : { code: "HOST_REJECTED", hostReasonCode },
        refreshRequired: hostReasonCode !== undefined && STALE_CODES.has(hostReasonCode),
      };
    }
    return undefined;
  }

  async function send(action: string, command: Omit<GateCommand, "kind"> & { kind: string }): Promise<GateOutcome> {
    try {
      const result = await deps.dispatch(command);
      return converge(result) ?? { ok: true, action, command };
    } catch (error) {
      return {
        ok: false,
        reason: { code: "TRANSPORT_FAILED", hostReasonCode: (error as { code?: string } | undefined)?.code },
      };
    }
  }

  function chooseBusyAction(intent: SubmitIntent): SubmitAction | undefined {
    const context = deps.context();
    const queueOk = available(CAPABILITY_BY_ACTION.queue);
    const steerOk = available(CAPABILITY_BY_ACTION.steer);
    if (intent.explicitAction !== undefined) {
      return available(CAPABILITY_BY_ACTION[intent.explicitAction]) ? intent.explicitAction : undefined;
    }
    const preference = context.busySubmitPreference;
    if (preference === "steer" && steerOk) return "steer";
    if (preference === "queue" && queueOk) return "queue";
    if (queueOk) return "queue";
    if (steerOk) return "steer";
    return undefined;
  }

  return {
    async submit(intent: SubmitIntent): Promise<GateOutcome> {
      const context = deps.context();
      const fenced = fence(context);
      if (fenced !== undefined) return fenced;

      const text = intent.text.trim();
      const attachments = intent.attachments ?? [];
      if (text.length === 0 && attachments.length === 0) {
        return { ok: false, reason: { code: "EMPTY_SUBMISSION" } };
      }
      if (attachments.length > 0) {
        const limits = deps.attachmentLimits();
        if (attachments.length > limits.maxCount) {
          return { ok: false, reason: { code: "ATTACHMENT_LIMIT", hostReasonCode: "maxCount" } };
        }
        for (const attachment of attachments) {
          if (attachment.bytes > limits.maxBytes) {
            return { ok: false, reason: { code: "ATTACHMENT_LIMIT", hostReasonCode: "maxBytes" } };
          }
          if (!limits.mediaTypes.includes(attachment.mediaType)) {
            return { ok: false, reason: { code: "ATTACHMENT_LIMIT", hostReasonCode: "mediaType" } };
          }
        }
      }

      let action: SubmitAction | undefined;
      if (!context.turnActive) {
        action = intent.explicitAction ?? "submit";
        if (!available(CAPABILITY_BY_ACTION[action])) {
          return { ok: false, reason: { code: "CAPABILITY_UNAVAILABLE" } };
        }
      } else {
        action = chooseBusyAction(intent);
        if (action === undefined) {
          return { ok: false, reason: { code: "CAPABILITY_UNAVAILABLE" } };
        }
      }

      return send(action, {
        kind: KIND_BY_ACTION[action],
        requestId: deps.nextRequestId(),
        ...leaseFields(),
        input: {
          ...(text.length > 0 ? { text } : {}),
          ...(attachments.length > 0 ? { attachmentIds: attachments.map((attachment) => attachment.id) } : {}),
        },
      });
    },

    async cancelTurn(turnId: string): Promise<GateOutcome> {
      const fenced = fence(deps.context());
      if (fenced !== undefined) return fenced;
      if (!available("session.cancel")) {
        return { ok: false, reason: { code: "CAPABILITY_UNAVAILABLE" } };
      }
      return send("cancel", {
        kind: "session.cancel",
        requestId: deps.nextRequestId(),
        ...leaseFields(),
        turnId,
        input: { turnId },
      });
    },

    async restartTurn(turnId: string, options: { confirmed: boolean; disruptive: boolean }): Promise<GateOutcome> {
      const fenced = fence(deps.context());
      if (fenced !== undefined) return fenced;
      if (!available("session.restart")) {
        return { ok: false, reason: { code: "CAPABILITY_UNAVAILABLE" } };
      }
      if (options.disruptive && !options.confirmed) {
        return { ok: false, reason: { code: "CONFIRMATION_REQUIRED" } };
      }
      return send("restart", {
        kind: "session.restart",
        requestId: deps.nextRequestId(),
        ...leaseFields(),
        turnId,
        input: { turnId },
      });
    },

    async respondInteraction(interaction: InteractionLike, choice: string): Promise<GateOutcome> {
      if (interaction.state !== "pending") {
        return { ok: false, reason: { code: "INTERACTION_TERMINAL" } };
      }
      if (!interaction.choices.includes(choice)) {
        return { ok: false, reason: { code: "CHOICE_NOT_OFFERED" } };
      }
      if (inFlight.has(interaction.correlationId)) {
        return { ok: false, reason: { code: "IN_FLIGHT" } };
      }
      const fenced = fence(deps.context());
      if (fenced !== undefined) return fenced;
      if (!available("interaction.approval")) {
        return { ok: false, reason: { code: "CAPABILITY_UNAVAILABLE" } };
      }
      inFlight.add(interaction.correlationId);
      try {
        return await send("respond", {
          kind: "interaction.respond",
          requestId: deps.nextRequestId(),
          ...leaseFields(),
          input: { correlationId: interaction.correlationId, decision: choice },
        });
      } finally {
        inFlight.delete(interaction.correlationId);
      }
    },

    async resumeGoal(goal: { goalId: string; revision: number }): Promise<GateOutcome> {
      const fenced = fence(deps.context());
      if (fenced !== undefined) return fenced;
      if (!available("goal.manage")) {
        return { ok: false, reason: { code: "CAPABILITY_UNAVAILABLE" } };
      }
      return send("goal-resume", {
        kind: "goal.resume",
        requestId: deps.nextRequestId(),
        ...leaseFields(),
        input: { goalId: goal.goalId, revision: goal.revision },
      });
    },

    async updateGoal(update: { text: string; revision: number }): Promise<GateOutcome> {
      const fenced = fence(deps.context());
      if (fenced !== undefined) return fenced;
      if (!available("goal.manage")) {
        return { ok: false, reason: { code: "CAPABILITY_UNAVAILABLE" } };
      }
      return send("goal-update", {
        kind: "goal.update",
        requestId: deps.nextRequestId(),
        ...leaseFields(),
        input: { text: update.text, revision: update.revision },
      });
    },
  };
}

export type CommandGate = ReturnType<typeof createCommandGate>;
