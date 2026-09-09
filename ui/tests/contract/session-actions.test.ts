import { beforeEach, describe, expect, it } from "vitest";
import { createSessionActions, type SessionActionCatalog } from "../../src/navigation/session-actions";
import type { ActionContext } from "../../src/facade/capability-selectors";

type CommandCall = { lease: unknown; command: { kind: string; requestId?: string; sessionId?: string; input?: unknown } };

function createHarness(options: {
  capabilities?: readonly string[];
  leaseMode?: "controller" | "observer";
  runtimeState?: string;
  confirm?: boolean;
  commandResult?: unknown;
  commandError?: unknown;
} = {}) {
  const capabilities = new Set(options.capabilities ?? [
    "session.create",
    "session.rename",
    "workspace.archiveSession",
    "session.restoreArchive",
    "session.delete",
    "session.fork",
  ]);
  const calls: CommandCall[] = [];
  const removed: string[] = [];
  const renamed: { sessionId: string; title: string }[] = [];
  const lease = {
    domainGenerationId: "gen-1",
    contractHash: "hash-1",
    sessionId: "session-1",
    leaseId: "lease-1",
    mode: options.leaseMode ?? "controller",
  };
  const context: ActionContext = {
    runtimeState: (options.runtimeState ?? "ready") as ActionContext["runtimeState"],
    leaseMode: lease.mode,
    availability: (capabilityId: string) =>
      capabilities.has(capabilityId)
        ? { available: true }
        : { available: false, reason: { code: "CAPABILITY_NOT_NEGOTIATED" } },
  };
  const catalog: SessionActionCatalog = {
    remove(sessionId: string) {
      removed.push(sessionId);
    },
    applyRename(sessionId: string, title: string) {
      renamed.push({ sessionId, title });
    },
  };
  let requestCounter = 0;
  const actions = createSessionActions({
    facade: {
      command<T>(_lease: unknown, command: CommandCall["command"]): Promise<T> {
        calls.push({ lease: _lease, command });
        if (options.commandError !== undefined) {
          return Promise.reject(options.commandError);
        }
        return Promise.resolve((options.commandResult ?? { accepted: true }) as T);
      },
    },
    lease: () => lease,
    context: () => context,
    catalog,
    confirm: () => Promise.resolve(options.confirm ?? true),
    nextRequestId: () => `req-${++requestCounter}`,
  });
  return { actions, calls, removed, renamed, lease };
}

describe("session action availability", () => {
  it("enables all six lifecycle actions for a controller on a ready Host", async () => {
    const { actions } = createHarness();
    const state = await actions.availability();
    for (const feature of ["create", "rename", "archive", "restore", "delete", "fork"] as const) {
      expect(state[feature].enabled, feature).toBe(true);
    }
  });

  it("fails closed when the Host did not negotiate a capability", async () => {
    const { actions } = createHarness({ capabilities: ["session.create"] });
    const state = await actions.availability();
    expect(state.create.enabled).toBe(true);
    expect(state.delete.enabled).toBe(false);
    if (!state.rename.enabled) {
      expect(state.rename.reason.code).toBe("CAPABILITY_UNAVAILABLE");
    }
  });

  it("blocks mutations for an observer lease", async () => {
    const { actions } = createHarness({ leaseMode: "observer" });
    const state = await actions.availability();
    expect(state.rename.enabled).toBe(false);
    if (!state.rename.enabled) {
      expect(state.rename.reason.code).toBe("OBSERVER_READ_ONLY");
    }
  });
});

describe("session action execution", () => {
  beforeEach(() => {
    // Harness is created per test; nothing shared to reset.
  });

  it("requires exactly one destructive confirmation before delete", async () => {
    const declined = createHarness({ confirm: false });
    const refused = await declined.actions.remove({ id: "session-1", title: "t" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason.code).toBe("CONFIRMATION_DECLINED");
    }
    expect(declined.calls).toHaveLength(0);
    expect(declined.removed).toEqual([]);

    const confirmed = createHarness({ confirm: true });
    const done = await confirmed.actions.remove({ id: "session-1", title: "t" });
    expect(done.ok).toBe(true);
    expect(confirmed.calls).toHaveLength(1);
    expect(confirmed.calls[0].command).toMatchObject({
      kind: "session.delete",
      sessionId: "session-1",
      requestId: "req-1",
    });
  });

  it("preserves projection and draft when the Host rejects a rename", async () => {
    const { actions, renamed } = createHarness({
      commandResult: { accepted: false, rejection: { code: "stale-lease" } },
    });
    const outcome = await actions.rename({ id: "session-1", title: "old" }, "new title");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason.code).toBe("HOST_REJECTED");
      expect(outcome.reason.hostReasonCode).toBe("stale-lease");
    }
    // The projection keeps the Host-owned title; the caller keeps the draft.
    expect(renamed).toEqual([]);
    if (!outcome.ok && "draft" in outcome) {
      expect(outcome.draft).toBe("new title");
    }
  });

  it("survives a transport failure without touching the catalog", async () => {
    const { actions, removed } = createHarness({
      commandError: Object.assign(new Error("boom"), { code: "host-unavailable" }),
      confirm: true,
    });
    const outcome = await actions.remove({ id: "session-1", title: "t" });
    expect(outcome.ok).toBe(false);
    expect(removed).toEqual([]);
  });

  it("cleans up locally only after a confirmed successful delete", async () => {
    const { actions, removed } = createHarness({ confirm: true });
    const outcome = await actions.remove({ id: "session-1", title: "t" });
    expect(outcome.ok).toBe(true);
    expect(removed).toEqual(["session-1"]);
  });

  it("applies the Host-confirmed title after a successful rename", async () => {
    const { actions, renamed } = createHarness({
      commandResult: { accepted: true, title: "new title" },
    });
    const outcome = await actions.rename({ id: "session-1", title: "old" }, "new title");
    expect(outcome.ok).toBe(true);
    expect(renamed).toEqual([{ sessionId: "session-1", title: "new title" }]);
  });
});
