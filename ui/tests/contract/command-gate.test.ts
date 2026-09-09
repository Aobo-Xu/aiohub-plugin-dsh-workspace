import { describe, expect, it } from "vitest";
import { createCommandGate, type GateContext } from "../../src/composer/command-gate";
import { createDraftStore } from "../../src/composer/draft-store";
import { buildNotification } from "../../src/interactions/notification-adapter";

const ALL_CAPS = [
  "session.submit-prompt",
  "session.updateQueue",
  "session.steer",
  "session.cancel",
  "session.restart",
  "interaction.approval",
  "goal.manage",
  "attachment.limits",
];

function context(overrides: Partial<GateContext> = {}): GateContext {
  return {
    runtimeState: "ready",
    leaseMode: "controller",
    lease: {
      domainGenerationId: "gen-1",
      contractHash: "hash-1",
      sessionId: "session-1",
      leaseId: "lease-1",
      mode: "controller",
    },
    turnActive: false,
    availability: (capabilityId: string) =>
      ALL_CAPS.includes(capabilityId) ? { available: true } : { available: false },
    ...overrides,
  };
}

function harness(overrides: Partial<GateContext> = {}) {
  let current = context(overrides);
  const dispatched: { kind: string; requestId?: string; input?: unknown }[] = [];
  let responses: unknown[] = [];
  let counter = 0;
  const gate = createCommandGate({
    context: () => current,
    nextRequestId: () => `req-${++counter}`,
    dispatch: (command) => {
      dispatched.push(command);
      const response = responses.shift();
      return response === undefined ? Promise.resolve({ accepted: true }) : Promise.resolve(response);
    },
    attachmentLimits: () => ({ maxCount: 2, maxBytes: 1024, mediaTypes: ["text/plain", "image/png"] }),
  });
  return {
    gate,
    dispatched,
    setContext(next: Partial<GateContext>) {
      current = { ...current, ...next };
    },
    setResponses(next: unknown[]) {
      responses = [...next];
    },
  };
}

describe("command gate submit semantics", () => {
  it("sends one idle-submit mutation for a valid idle prompt", async () => {
    const { gate, dispatched } = harness();
    const outcome = await gate.submit({ text: "fix the bug" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.action).toBe("submit");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ kind: "session.submit-prompt", requestId: "req-1" });
  });

  it("honors the Host busy-submit preference and defaults to Queue otherwise", async () => {
    const preferred = harness({ turnActive: true, busySubmitPreference: "steer" });
    const first = await preferred.gate.submit({ text: "also check logs" });
    expect(first.ok && first.action).toBe("steer");

    const fallback = harness({ turnActive: true });
    const second = await fallback.gate.submit({ text: "queued work" });
    expect(second.ok && second.action).toBe("queue");
    expect(second.ok && second.command.kind).toBe("session.updateQueue");
  });

  it("keeps Steer an explicit distinct choice and button/Enter identical", async () => {
    const { gate, dispatched } = harness({ turnActive: true });
    const explicit = await gate.submit({ text: "steer now", explicitAction: "steer" });
    expect(explicit.ok && explicit.action).toBe("steer");
    expect(dispatched[0].kind).toBe("session.steer");
    // The component routes both the button and Enter through submit(); the
    // decision is a pure function of intent + context.
    const enter = await gate.submit({ text: "steer now", explicitAction: "steer" });
    expect(enter.ok && enter.action).toBe("steer");
  });

  it("offers only the single advertised busy action", async () => {
    const onlyQueue = harness({
      turnActive: true,
      availability: (capabilityId) =>
        capabilityId === "session.updateQueue" || capabilityId === "session.submit-prompt"
          ? { available: true }
          : { available: false },
    });
    const queued = await onlyQueue.gate.submit({ text: "x" });
    expect(queued.ok && queued.action).toBe("queue");
    const explicitSteer = await onlyQueue.gate.submit({ text: "x", explicitAction: "steer" });
    expect(explicitSteer.ok).toBe(false);
    if (!explicitSteer.ok) expect(explicitSteer.reason.code).toBe("CAPABILITY_UNAVAILABLE");
  });

  it("rejects blank submissions without a mutation", async () => {
    const { gate, dispatched } = harness();
    const outcome = await gate.submit({ text: "   " });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason.code).toBe("EMPTY_SUBMISSION");
    expect(dispatched).toHaveLength(0);
  });

  it("allows attachment-only submission and enforces runtime limits", async () => {
    const { gate, dispatched } = harness();
    const allowed = await gate.submit({
      text: "",
      attachments: [{ id: "a-1", mediaType: "text/plain", bytes: 10 }],
    });
    expect(allowed.ok).toBe(true);
    expect(dispatched).toHaveLength(1);

    const tooMany = await gate.submit({
      text: "",
      attachments: [
        { id: "a-1", mediaType: "text/plain", bytes: 10 },
        { id: "a-2", mediaType: "text/plain", bytes: 10 },
        { id: "a-3", mediaType: "text/plain", bytes: 10 },
      ],
    });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.reason.code).toBe("ATTACHMENT_LIMIT");
    const badType = await gate.submit({
      text: "",
      attachments: [{ id: "a-4", mediaType: "application/exe", bytes: 10 }],
    });
    expect(badType.ok).toBe(false);
    expect(dispatched).toHaveLength(1);
  });
});

describe("command gate lease and lifecycle fencing", () => {
  it("rejects observers and pending transfers before any dispatch", async () => {
    const observer = harness({ leaseMode: "observer" });
    const denied = await observer.gate.submit({ text: "x" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason.code).toBe("OBSERVER_READ_ONLY");
    expect(observer.dispatched).toHaveLength(0);

    const pending = harness({ transferPending: true });
    const fenced = await pending.gate.submit({ text: "x" });
    expect(fenced.ok).toBe(false);
    if (!fenced.ok) expect(fenced.reason.code).toBe("TRANSFER_PENDING");
    expect(pending.dispatched).toHaveLength(0);
  });

  it("rejects stale leases/generations and never retries automatically", async () => {
    const { gate, dispatched, setResponses } = harness();
    setResponses([{ accepted: false, rejection: { code: "stale-lease" } }]);
    const first = await gate.submit({ text: "x" });
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.reason.code).toBe("HOST_REJECTED");
      expect(first.reason.hostReasonCode).toBe("stale-lease");
      expect(first.refreshRequired).toBe(true);
    }
    expect(dispatched).toHaveLength(1);

    const staleGen = harness({ generationStale: true });
    const fenced = await staleGen.gate.submit({ text: "x" });
    expect(fenced.ok).toBe(false);
    if (!fenced.ok) expect(fenced.reason.code).toBe("STALE_GENERATION");
    expect(staleGen.dispatched).toHaveLength(0);
  });

  it("cancels one Turn and requires confirmation for disruptive restart", async () => {
    const { gate, dispatched } = harness({ turnActive: true });
    const cancel = await gate.cancelTurn("turn-1");
    expect(cancel.ok).toBe(true);
    expect(dispatched[0]).toMatchObject({ kind: "session.cancel" });

    const unconfirmed = await gate.restartTurn("turn-1", { confirmed: false, disruptive: true });
    expect(unconfirmed.ok).toBe(false);
    if (!unconfirmed.ok) expect(unconfirmed.reason.code).toBe("CONFIRMATION_REQUIRED");
    expect(dispatched).toHaveLength(1);

    const confirmed = await gate.restartTurn("turn-1", { confirmed: true, disruptive: true });
    expect(confirmed.ok).toBe(true);
    expect(dispatched[1]).toMatchObject({ kind: "session.restart" });
  });
});

describe("command gate interactions", () => {
  const approval = {
    correlationId: "int-1",
    kind: "approval" as const,
    operations: [{ id: "op-1", summary: "write file" }, { id: "op-2", summary: "run test" }],
    choices: ["allow", "deny"] as const,
    state: "pending" as const,
  };

  it("answers with the exact identity once and blocks duplicate clicks", async () => {
    const { gate, dispatched } = harness();
    const first = gate.respondInteraction(approval, "allow");
    const duplicate = gate.respondInteraction(approval, "allow");
    expect((await first).ok).toBe(true);
    expect((await duplicate).ok).toBe(false);
    const duplicateResult = await duplicate;
    if (!duplicateResult.ok) expect(duplicateResult.reason.code).toBe("IN_FLIGHT");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].input).toMatchObject({ correlationId: "int-1", decision: "allow" });
  });

  it("never resolves one interaction with another identity", async () => {
    const { gate, dispatched } = harness();
    await gate.respondInteraction(approval, "allow");
    const other = { ...approval, correlationId: "int-2" };
    await gate.respondInteraction(other, "deny");
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0].input).toMatchObject({ correlationId: "int-1" });
    expect(dispatched[1].input).toMatchObject({ correlationId: "int-2", decision: "deny" });
  });

  it("refuses late responses to terminal interactions", async () => {
    const { gate, dispatched } = harness();
    const resolved = await gate.respondInteraction({ ...approval, state: "resolved" }, "allow");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason.code).toBe("INTERACTION_TERMINAL");
    expect(dispatched).toHaveLength(0);
  });

  it("rejects choices the Host did not offer", async () => {
    const { gate, dispatched } = harness();
    const outcome = await gate.respondInteraction(approval, "allow-once-and-always");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason.code).toBe("CHOICE_NOT_OFFERED");
    expect(dispatched).toHaveLength(0);
  });
});

describe("draft store", () => {
  it("keeps drafts across navigation and pending transfer, in memory only", () => {
    const drafts = createDraftStore();
    drafts.set("session-1", { text: "half written", attachments: [] });
    expect(drafts.get("session-2")).toBeUndefined();
    expect(drafts.get("session-1")?.text).toBe("half written");
    // Navigation and transfer never clear drafts.
    drafts.noteSessionSwitch("session-2");
    drafts.noteTransferPending("session-1");
    expect(drafts.get("session-1")?.text).toBe("half written");
    expect(drafts.snapshotForPersistence()).toBeUndefined();
  });

  it("clears a draft only after a successful submission", async () => {
    const drafts = createDraftStore();
    drafts.set("session-1", { text: "send me", attachments: [] });
    drafts.markSubmitted("session-1", false);
    expect(drafts.get("session-1")?.text).toBe("send me");
    drafts.markSubmitted("session-1", true);
    expect(drafts.get("session-1")).toBeUndefined();
  });
});

describe("goal CAS fencing", () => {
  it("surfaces a revision conflict without retrying", async () => {
    const { gate, dispatched, setResponses } = harness();
    setResponses([{ accepted: false, rejection: { code: "revision-conflict" } }]);
    const outcome = await gate.updateGoal({ text: "new objective", revision: 3 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason.hostReasonCode).toBe("revision-conflict");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].input).toMatchObject({ revision: 3 });
  });
});

describe("notification adapter", () => {
  it("redacts payloads to navigation-minimal context", () => {
    const notification = buildNotification({
      kind: "turn/completed",
      sessionId: "session-1",
      workspaceId: "ws-1",
      workspaceName: "Alpha",
      data: {
        content: [{ type: "text", text: "secret prompt text" }],
        apiKey: "sk-live-123",
        path: "C:/private/file.txt",
      },
    });
    const serialized = JSON.stringify(notification);
    expect(serialized).not.toContain("secret prompt text");
    expect(serialized).not.toContain("sk-live-123");
    expect(serialized).not.toContain("C:/private/file.txt");
    expect(notification.navigate).toMatchObject({ workspaceId: "ws-1", sessionId: "session-1" });
    expect(notification.body.length).toBeGreaterThan(0);
  });

  it("routes approval notifications to the exact interaction without control acquisition", () => {
    const notification = buildNotification({
      kind: "interaction/approval",
      sessionId: "session-2",
      workspaceId: "ws-1",
      interactionId: "int-9",
      data: { operations: 3 },
    });
    expect(notification.navigate).toMatchObject({
      workspaceId: "ws-1",
      sessionId: "session-2",
      interactionId: "int-9",
    });
    expect(notification.acquireControl).toBe(false);
    expect(notification.cancelBackground).toBe(false);
  });
});
