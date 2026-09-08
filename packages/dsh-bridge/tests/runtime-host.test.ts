import { describe, expect, it, vi } from "vitest";
import type { DshHost } from "../src/host/create-host.js";
import { createRuntimeHost } from "../src/host/runtime-host.js";

function fakeHost(): DshHost {
  return {
    adapterIdentity: {
      adapterId: "fake",
      releaseTag: "fixture",
      releaseCommit: "f".repeat(40),
      schemaVersion: 1,
      serviceEvidence: ["session"],
    },
    capabilities: () => [],
    availability: () => ({ available: true }),
    applyNegotiation: () => undefined,
    port: () => ({ operationAvailability: () => ({ available: true }) }),
    dispose: vi.fn(async () => undefined),
  };
}

describe("long-lived runtime host", () => {
  it("settles one host for multiple session attachments", async () => {
    const host = fakeHost();
    const start = vi.fn(async () => host);
    const runtime = createRuntimeHost({ start });

    await runtime.attachSession("session-1");
    await runtime.attachSession("session-2");

    expect(start).toHaveBeenCalledTimes(1);
    expect(runtime.sessions()).toEqual(["session-1", "session-2"]);
    expect(runtime.state()).toBe("ready");
  });

  it("fences mutations during maintenance and interrupts without replay on crash", async () => {
    const submit = vi.fn(async () => "accepted");
    const runtime = createRuntimeHost({ start: async () => fakeHost() });
    await runtime.attachSession("session-1");

    expect(await runtime.mutate("turn-1", submit)).toBe("accepted");
    runtime.enterMaintenance();
    await expect(runtime.mutate("turn-2", submit)).rejects.toThrow(
      "HOST_MUTATIONS_FENCED",
    );
    runtime.leaveMaintenance();
    runtime.trackHandle("terminal-1");
    await runtime.crash();

    expect(runtime.interruptedHandles()).toEqual(["terminal-1", "turn-1"]);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(runtime.state()).toBe("crashed");
  });

  it("flushes durable state before disposing the settled Cordis host", async () => {
    const order: string[] = [];
    const host = fakeHost();
    host.dispose = vi.fn(async () => {
      order.push("dispose");
    });
    const runtime = createRuntimeHost({
      start: async () => host,
      flush: async () => {
        order.push("flush");
      },
    });
    await runtime.attachSession("session-1");

    await runtime.dispose();

    expect(order).toEqual(["flush", "dispose"]);
    expect(runtime.state()).toBe("stopped");
  });

  it("exposes explicit upgrade, recovery, and incompatible fences", async () => {
    const runtime = createRuntimeHost({ start: async () => fakeHost() });
    await runtime.attachSession("session-1");

    runtime.beginUpgrade();
    expect(runtime.state()).toBe("upgrading");
    runtime.beginRecovery();
    expect(runtime.state()).toBe("recovering");
    runtime.markReady();
    expect(runtime.state()).toBe("ready");
    runtime.markIncompatible();
    expect(runtime.state()).toBe("incompatible");
    await expect(runtime.mutate("turn-1", async () => undefined)).rejects.toThrow(
      "HOST_MUTATIONS_FENCED",
    );
  });

  it("does not misclassify an ordinary startup failure as an incompatible runtime", async () => {
    const runtime = createRuntimeHost({
      start: async () => {
        throw new Error("runtime process exited");
      },
    });

    await expect(runtime.attachSession("session-1")).rejects.toThrow(
      "runtime process exited",
    );
    expect(runtime.state()).toBe("crashed");
  });

  it("recovers with a new settled host without replaying prior mutations", async () => {
    const start = vi.fn(async () => fakeHost());
    const submit = vi.fn(async () => "accepted");
    const runtime = createRuntimeHost({ start });
    await runtime.attachSession("session-1");
    await runtime.mutate("turn-1", submit);
    await runtime.crash();

    await runtime.recover();

    expect(start).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(runtime.sessions()).toEqual(["session-1"]);
    expect(runtime.interruptedHandles()).toEqual(["turn-1"]);
    expect(runtime.state()).toBe("ready");
  });
});
