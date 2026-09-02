import { describe, expect, it } from "vitest";
import { createControllerLeaseService } from "../../packages/dsh-bridge/src/controller-leases.js";
import { createSessionService } from "../../packages/dsh-bridge/src/sessions.js";

const runtimeRef = {
  domainGenerationId: "generation-1",
  contractHash: "contract-hash-1",
} as const;

function acquireInput(viewId: string, requestedMode: "controller" | "observer") {
  return {
    ...runtimeRef,
    sessionId: "session-1",
    viewId,
    requestedMode,
  };
}

describe("controller lease fencing", () => {
  it("allows one controller and multiple observers", async () => {
    const leases = createControllerLeaseService();
    const controller = await leases.acquire(acquireInput("view-a", "controller"));
    const observer = await leases.acquire(acquireInput("view-b", "observer"));
    const anotherObserver = await leases.acquire(acquireInput("view-c", "observer"));

    expect(controller.mode).toBe("controller");
    expect(observer.mode).toBe("observer");
    expect(anotherObserver.mode).toBe("observer");
  });

  it("transfers the controller and fences the old lease", async () => {
    const leases = createControllerLeaseService();
    const oldController = await leases.acquire(acquireInput("view-a", "controller"));
    const observer = await leases.acquire(acquireInput("view-b", "observer"));
    const nextController = await leases.transfer({
      ...oldController,
      targetViewId: "view-c",
    });

    expect(nextController.mode).toBe("controller");
    expect(nextController.leaseId).not.toBe(oldController.leaseId);
    expect(observer.mode).toBe("observer");

    expect(() => leases.assertMutable(oldController)).toThrowError(
      expect.objectContaining({ code: "STALE_LEASE" }),
    );
  });

  it("rejects mutations from observers and stale generations", async () => {
    const leases = createControllerLeaseService();
    const controller = await leases.acquire(acquireInput("view-a", "controller"));
    const observer = await leases.acquire(acquireInput("view-b", "observer"));
    const staleController = {
      ...controller,
      domainGenerationId: "generation-0",
    };

    expect(() => leases.assertMutable(observer)).toThrowError(
      expect.objectContaining({ code: "OBSERVER_MUTATION" }),
    );
    expect(() => leases.assertMutable(staleController)).toThrowError(
      expect.objectContaining({ code: "STALE_GENERATION" }),
    );
  });
});

describe("session command map", () => {
  const commandKinds = [
    "create",
    "list",
    "search",
    "resume",
    "history",
    "prompt",
    "cancel",
    "steer",
    "queue",
    "fork",
    "rename",
    "model",
    "workspace",
  ] as const;

  it("routes every required command through the public service map", async () => {
    const calls: string[] = [];
    const session = Object.fromEntries(
      commandKinds.map((kind) => [
        kind,
        async (...args: unknown[]) => {
          calls.push(kind);
          return { kind, args };
        },
      ]),
    );
    const leases = createControllerLeaseService();
    const controller = await leases.acquire(acquireInput("view-a", "controller"));
    const service = createSessionService({
      session,
      assertMutable: leases.assertMutable,
    });

    for (const kind of commandKinds) {
      await service.command(controller, { kind, input: {} });
    }

    expect(calls).toEqual([...commandKinds]);
  });

  it("rejects an unknown command", async () => {
    const leases = createControllerLeaseService();
    const controller = await leases.acquire(acquireInput("view-a", "controller"));
    const service = createSessionService({
      session: {},
      assertMutable: leases.assertMutable,
    });

    await expect(
      service.command(controller, { kind: "not-a-command", input: {} }),
    ).rejects.toMatchObject({ code: "UNKNOWN_SESSION_COMMAND" });
  });

  it("requires a controller lease before invoking DSH", async () => {
    const leases = createControllerLeaseService();
    const observer = await leases.acquire(acquireInput("view-b", "observer"));
    const session = {
      create: async () => {
        throw new Error("must not be called");
      },
    };
    const service = createSessionService({
      session,
      assertMutable: leases.assertMutable,
    });

    await expect(
      service.command(observer, { kind: "create", input: {} }),
    ).rejects.toMatchObject({ code: "OBSERVER_MUTATION" });
  });
});
