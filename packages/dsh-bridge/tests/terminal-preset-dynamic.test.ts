import { describe, expect, it, vi } from "vitest";
import { createTerminalService } from "../src/terminals/terminal-service.js";
import { createPresetService } from "../src/presets/preset-service.js";
import { createDynamicPackageService } from "../src/dynamic-runtime/dynamic-package-service.js";

describe("DSH terminal, preset and dynamic host services", () => {
  it("fences terminal handles after generation stop and never replays input", async () => {
    const open = vi.fn(async () => ({ handleId: "terminal-1", motd: "ready" }));
    const send = vi.fn(async () => ({ waitReason: "idle" }));
    const close = vi.fn(async () => true);
    const service = createTerminalService({
      port: {
        operationAvailability: () => ({ available: true }),
        open,
        send,
        close,
      },
    });
    const handle = await service.open({ sessionId: "session-1", generation: "generation-1" });
    await service.input(handle.handleId, { sessionId: "session-1", generation: "generation-1", text: "echo hi" });
    await service.stopGeneration("generation-1");
    await expect(service.input(handle.handleId, { sessionId: "session-1", generation: "generation-1", text: "echo again" })).rejects.toMatchObject({
      code: "TERMINAL_NOT_WRITABLE",
    });
    expect(send).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("exposes presets by capability and does not invent missing choices", async () => {
    const service = createPresetService({
      port: {
        operationAvailability: (id) => id === "preset.catalog"
          ? { available: true }
          : { available: false, reason: { code: "CAPABILITY_NOT_NEGOTIATED" } },
        catalog: async () => [{ id: "minimal", scope: "session" }],
      },
    });
    await expect(service.catalog()).resolves.toEqual([{ id: "minimal", scope: "session" }]);
    await expect(service.select("standard", "session-1")).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capabilityId: "preset.select",
    });
  });

  it("requires explicit confirmation for host-half packages and always closes browser-half", async () => {
    const define = vi.fn(async (input: unknown) => ({ id: "pkg-1", input }));
    const service = createDynamicPackageService({
      port: {
        operationAvailability: (id) => id === "dynamic.host.define"
          ? { available: true }
          : { available: false, reason: { code: "CAPABILITY_NOT_NEGOTIATED" } },
        define,
      },
    });
    await expect(service.define({
      packageId: "pkg-1",
      sessionId: "session-1",
      generation: "generation-1",
      confirmed: false,
    })).rejects.toMatchObject({ code: "DYNAMIC_CONFIRMATION_REQUIRED" });
    await expect(service.define({
      packageId: "pkg-1",
      sessionId: "session-1",
      generation: "generation-1",
      confirmed: true,
    })).resolves.toMatchObject({ id: "pkg-1" });
    expect(define).toHaveBeenCalledOnce();
    await expect(service.browserInventory()).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capabilityId: "dynamic.browser.inventory",
    });
  });
});
