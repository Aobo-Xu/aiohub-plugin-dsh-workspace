import { describe, expect, it } from "vitest";
import { hostMethodCapability } from "../src/host/cordis-plugin.js";

describe("production Host dispatch contract", () => {
  it("maps every exposed method to capability evidence without version checks", () => {
    expect(hostMethodCapability("workspace.list")).toBe("workspace.follow");
    expect(hostMethodCapability("session.history")).toBe("session.history");
    expect(hostMethodCapability("session.updateQueue")).toBe("session.update-queue");
    expect(hostMethodCapability("terminal.input")).toBe("terminal.send");
    expect(hostMethodCapability("preset.catalog")).toBe("preset.catalog");
    expect(hostMethodCapability("dynamic.host.inventory")).toBe("dynamic.host.inventory");
    expect(hostMethodCapability("attachment.limits")).toBe("attachment.limits");
    expect(hostMethodCapability("context.summary")).toBe("session.snapshot");
    expect(hostMethodCapability("dynamic.browser.inventory")).toBeUndefined();
  });
});
