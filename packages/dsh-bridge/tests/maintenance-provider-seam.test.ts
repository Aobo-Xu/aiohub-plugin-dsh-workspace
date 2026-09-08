import { describe, expect, it, vi } from "vitest";
import { createMaintenanceService } from "../src/maintenance/maintenance-service.js";
import { createExternalToolProvider } from "../src/external-tools/provider.js";

describe("DSH maintenance and external provider seams", () => {
  it("runs maintenance in a fenced, observable order", async () => {
    const steps: string[] = [];
    const host = {
      enterMaintenance: () => steps.push("enter"),
      beginUpgrade: () => steps.push("upgrade"),
      leaveMaintenance: () => steps.push("leave"),
    };
    const service = createMaintenanceService({
      host,
      drain: async () => steps.push("drain"),
      cancel: async () => steps.push("cancel"),
      migrate: async () => steps.push("migrate"),
      health: async () => { steps.push("health"); return true; },
      restart: async () => steps.push("restart"),
      commit: async () => steps.push("commit"),
    });

    await expect(service.run()).resolves.toEqual({ status: "committed", steps: [
      "enter", "cancel", "drain", "upgrade", "migrate", "health", "restart", "commit", "leave",
    ] });
    expect(steps).toEqual(["enter", "cancel", "drain", "upgrade", "migrate", "health", "restart", "commit", "leave"]);
  });

  it("keeps an unconfigured external provider unavailable", async () => {
    const provider = createExternalToolProvider();
    await expect(provider.connect()).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capabilityId: "external-tools.connect",
    });
    await expect(provider.catalog()).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(vi.isMockFunction(provider.invoke)).toBe(false);
  });
});
