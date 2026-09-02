import { describe, expect, it } from "vitest";
import { createSnapshotRecovery } from "../../packages/dsh-bridge/src/snapshot-recovery.js";
import type { RuntimeEvent, SessionSnapshot } from "../../packages/runtime-facade/src/types.js";

function event(kind: string, data: unknown = {}): RuntimeEvent {
  return { kind, sessionId: "session-1", turnId: "turn-1", data };
}

function snapshot(seq: number, cursor: string, facts: readonly RuntimeEvent[] = []): SessionSnapshot {
  return {
    contractHash: "contract-hash-1",
    cursor,
    domainGenerationId: "generation-1",
    durableFacts: facts,
    seq,
    sessionId: "session-1",
  };
}

describe("snapshot recovery", () => {
  it("marks a sequence gap as requiring resync", () => {
    const recovery = createSnapshotRecovery({ maxQueue: 4 });

    expect(recovery.accept({
      seq: 1,
      generation: "generation-1",
      durability: "durable",
      correlationId: "event-1",
      payload: event("start"),
    })).toBe("applied");

    expect(recovery.accept({
      seq: 3,
      generation: "generation-1",
      durability: "disposable",
      correlationId: "event-3",
      payload: event("token-delta"),
    })).toBe("resync-required");

    expect(recovery.state()).toBe("resync-required");
  });

  it("coalesces duplicate events", () => {
    const recovery = createSnapshotRecovery({ maxQueue: 4 });
    const input = {
      seq: 1,
      generation: "generation-1",
      durability: "durable" as const,
      correlationId: "event-1",
      payload: event("start"),
    };

    expect(recovery.accept(input)).toBe("applied");
    expect(recovery.accept(input)).toBe("coalesced");
    expect(recovery.state()).toBe("ready");
  });

  it("requires resync when the generation changes", () => {
    const recovery = createSnapshotRecovery({ maxQueue: 4 });

    expect(recovery.accept({
      seq: 1,
      generation: "generation-1",
      durability: "durable",
      correlationId: "event-1",
      payload: event("start"),
    })).toBe("applied");

    expect(recovery.accept({
      seq: 2,
      generation: "generation-2",
      durability: "durable",
      correlationId: "event-2",
      payload: event("completed"),
    })).toBe("resync-required");
  });

  it("rebuilds from a snapshot and then accepts newer events", async () => {
    const recovery = createSnapshotRecovery({ maxQueue: 4 });
    recovery.accept({
      seq: 1,
      generation: "generation-1",
      durability: "durable",
      correlationId: "event-1",
      payload: event("start"),
    });

    const completedTool = event("tool-result", { callId: "call-1", status: "completed" });
    await recovery.applySnapshot(snapshot(8, "cursor-8", [completedTool]));

    expect(recovery.state()).toBe("ready");
    expect(recovery.durableFacts()).toEqual([completedTool]);

    expect(recovery.accept({
      seq: 9,
      generation: "generation-1",
      durability: "disposable",
      correlationId: "event-9",
      payload: event("token-delta"),
    })).toBe("applied");
  });

  it("preserves terminal facts after cold resume", async () => {
    const recovery = createSnapshotRecovery({ maxQueue: 4 });
    const terminal = event("error", { message: "failed" });
    await recovery.applySnapshot(snapshot(5, "cursor-5", [terminal]));

    expect(recovery.durableFacts()).toContainEqual(terminal);
  });
});
