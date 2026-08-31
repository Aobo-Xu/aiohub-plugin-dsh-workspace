import { describe, expect, it, vi } from "vitest";
import {
  AioSidecarTransport,
  DSH_RUNTIME_EVENT_NAME,
} from "../src/aio-sidecar-transport.js";
import { SidecarRuntimeFacade } from "../src/runtime-facade.js";
import type {
  ControllerLease,
  InitializeResult,
  RuntimeEvent,
  SessionSnapshot,
  SidecarTransport,
} from "../src/types.js";

const runtimeRef = {
  domainGenerationId: "generation-1",
  contractHash: "contract-1",
};

const initializeResult: InitializeResult = {
  ...runtimeRef,
  state: "ready",
  capabilities: ["execution-domain:dsh"],
  sandbox: { level: "full", backend: "restricted-token" },
};

const controllerLease: ControllerLease = {
  ...runtimeRef,
  sessionId: "session-1",
  leaseId: "lease-1",
  mode: "controller",
};

const snapshot: SessionSnapshot = {
  ...runtimeRef,
  sessionId: "session-1",
  cursor: "cursor-1",
  seq: 1,
  durableFacts: [{ kind: "session-ready", data: { ready: true } }],
};

function createTransport(
  requestResult: unknown,
  eventValue: unknown = undefined
): SidecarTransport & {
  request: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
} {
  return {
    request: vi.fn().mockResolvedValue(requestResult),
    onEvent: vi.fn((callback: (value: unknown) => void) => {
      if (eventValue !== undefined) callback(eventValue);
      return vi.fn();
    }),
    kill: vi.fn().mockResolvedValue(undefined),
  };
}

describe("AioSidecarTransport public PluginProxy seam", () => {
  it("declares one stable DSH runtime event name", () => {
    expect(DSH_RUNTIME_EVENT_NAME).toBe("dsh-runtime-event");
  });

  it("delegates already-decoded dynamic results with the proxy receiver", async () => {
    const unsubscribe = vi.fn();
    const proxy = {
      marker: "public-proxy",
      initialize(this: { marker: string }, params: unknown) {
        expect(this.marker).toBe("public-proxy");
        expect(params).toEqual({ hostApiVersion: 3 });
        return Promise.resolve({ ready: true });
      },
      disable: vi.fn().mockResolvedValue(undefined),
      onSidecarEvent: vi.fn(() => unsubscribe),
    };
    const transport = new AioSidecarTransport(proxy);

    await expect(
      transport.request("initialize", { hostApiVersion: 3 })
    ).resolves.toEqual({ ready: true });
  });

  it("fails closed when the public proxy does not expose a requested method", async () => {
    const transport = new AioSidecarTransport({
      disable: vi.fn().mockResolvedValue(undefined),
      onSidecarEvent: vi.fn(),
    });

    await expect(transport.request("initialize", {})).rejects.toThrow(
      "does not expose Sidecar method initialize"
    );
  });

  it("subscribes and unsubscribes through the named public Sidecar event", () => {
    let eventListener: ((value: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const proxy = {
      disable: vi.fn().mockResolvedValue(undefined),
      onSidecarEvent: vi.fn(
        (eventName: string, listener: (value: unknown) => void) => {
          expect(eventName).toBe(DSH_RUNTIME_EVENT_NAME);
          eventListener = listener;
          return unsubscribe;
        }
      ),
    };
    const transport = new AioSidecarTransport(proxy);
    const listener = vi.fn();

    const stop = transport.onEvent(listener);
    eventListener?.({ kind: "runtime-ready", data: {} });
    stop();

    expect(listener).toHaveBeenCalledWith({ kind: "runtime-ready", data: {} });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("delegates kill to the public proxy disable lifecycle", async () => {
    const disable = vi.fn().mockResolvedValue(undefined);
    const transport = new AioSidecarTransport({ disable });

    await transport.kill();

    expect(disable).toHaveBeenCalledOnce();
  });
});

describe("SidecarRuntimeFacade validation and lifecycle", () => {
  it("rejects a malformed initialize result", async () => {
    const facade = new SidecarRuntimeFacade(createTransport({}));

    await expect(
      facade.initialize({
        hostApiVersion: 3,
        platform: "win32-x64",
        pluginDataDir: "C:/dsh",
        prewarm: false,
      })
    ).rejects.toThrow("Invalid initialize result");
  });

  it.each(["acquireSession", "transferController"] as const)(
    "rejects malformed %s lease results",
    async (operation) => {
      const facade = new SidecarRuntimeFacade(createTransport({ ...runtimeRef }));

      if (operation === "acquireSession") {
        await expect(
          facade.acquireSession({
            ...runtimeRef,
            sessionId: "session-1",
            viewId: "view-1",
            requestedMode: "controller",
          })
        ).rejects.toThrow("Invalid controller lease");
      } else {
        await expect(
          facade.transferController({
            ...controllerLease,
            targetViewId: "view-2",
          })
        ).rejects.toThrow("Invalid controller lease");
      }
    }
  );

  it("rejects a malformed snapshot", async () => {
    const facade = new SidecarRuntimeFacade(
      createTransport({ ...runtimeRef, sessionId: "session-1", cursor: "cursor-1", seq: 1 })
    );

    await expect(facade.snapshot("session-1")).rejects.toThrow(
      "Invalid session snapshot"
    );
  });

  it("rejects malformed runtime events before dispatch", () => {
    const listener = vi.fn();
    const facade = new SidecarRuntimeFacade(
      createTransport(initializeResult, { kind: "bad", sessionId: 42, data: {} })
    );

    expect(() => facade.subscribe(listener)).toThrow("Invalid runtime event");
    expect(listener).not.toHaveBeenCalled();
  });

  it("forwards shutdown reason before killing the outer Sidecar", async () => {
    const transport = createTransport(undefined);
    const facade = new SidecarRuntimeFacade(transport);

    await facade.shutdown("user-stop");

    expect(transport.request).toHaveBeenCalledWith("shutdown", {
      reason: "user-stop",
    });
    expect(transport.kill).toHaveBeenCalledOnce();
    expect(transport.request.mock.invocationCallOrder[0]).toBeLessThan(
      transport.kill.mock.invocationCallOrder[0]
    );
  });

  it("still kills the outer Sidecar when graceful shutdown fails", async () => {
    const transport = createTransport(undefined);
    transport.request.mockRejectedValueOnce(new Error("graceful shutdown failed"));
    const facade = new SidecarRuntimeFacade(transport);

    await expect(facade.shutdown("aio-exit")).rejects.toThrow(
      "graceful shutdown failed"
    );
    expect(transport.kill).toHaveBeenCalledOnce();
  });

  it("preserves an undefined graceful shutdown rejection after kill succeeds", async () => {
    const transport = createTransport(undefined);
    transport.request.mockRejectedValueOnce(undefined);
    const facade = new SidecarRuntimeFacade(transport);

    await expect(facade.shutdown("aio-exit")).rejects.toBeUndefined();
    expect(transport.kill).toHaveBeenCalledOnce();
  });

  it("aggregates undefined graceful and kill failures", async () => {
    const transport = createTransport(undefined);
    const killError = new Error("outer disable failed");
    transport.request.mockRejectedValueOnce(undefined);
    transport.kill.mockRejectedValueOnce(killError);
    const facade = new SidecarRuntimeFacade(transport);

    let failure: unknown;
    try {
      await facade.shutdown("plugin-disabled");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([undefined, killError]);
  });
});
