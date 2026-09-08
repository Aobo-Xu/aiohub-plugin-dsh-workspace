import { describe, expect, it } from "vitest";
import { createApprovalBroker } from "../src/host/interaction-broker.js";

function approvalRequest() {
  const events = [
    { type: "turn/start", data: { turnId: "turn-1" } },
    {
      type: "approval/asked",
      data: { id: "approval-1", toolName: "pwsh", callId: "call-1" },
    },
  ];
  return {
    agent: {
      session: {
        id: "session-1",
        seq: events.length,
        eventAt: (seq: number) => events[seq],
      },
    },
    toolName: "pwsh",
    callId: "call-1",
    reason: "run a command",
  };
}

describe("production Host approval broker", () => {
  it("projects the DSH-issued identity and resolves one matching answer", async () => {
    const broker = createApprovalBroker();
    const pending = broker.open(approvalRequest());

    expect(broker.list("session-1")).toEqual([
      {
        correlationId: "approval-1",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: "approval",
        data: {
          toolName: "pwsh",
          callId: "call-1",
          reason: "run a command",
        },
      },
    ]);

    expect(
      broker.respond({
        correlationId: "approval-1",
        sessionId: "session-1",
        decision: "allow",
      }),
    ).toEqual({ outcome: "allowed-once" });
    await expect(pending).resolves.toBe("allowed-once");
    expect(broker.list("session-1")).toEqual([]);
    expect(() => broker.respond({
      correlationId: "approval-1",
      sessionId: "session-1",
      decision: "allow",
    })).toThrow("INTERACTION_ALREADY_RESOLVED");
  });

  it("fails closed when the DSH audit identity cannot be proved", async () => {
    const broker = createApprovalBroker();
    await expect(broker.open({
      ...approvalRequest(),
      agent: {
        session: {
          id: "session-1",
          seq: 0,
          eventAt: () => undefined,
        },
      },
    })).resolves.toBe("unavailable");
    expect(broker.list("session-1")).toEqual([]);
  });
});
