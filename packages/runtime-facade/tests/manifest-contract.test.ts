import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DSH_CAPABILITY } from "../src/types.js";

describe("DSH manifest contract", () => {
  it("declares a resident API v3 DSH execution domain on the first-release platform", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../../manifest.json", import.meta.url), "utf8")
    );

    expect(manifest).toMatchObject({
      id: "dsh-coding-workspace",
      name: "Coding工作站",
      type: "sidecar",
      host: { apiVersion: 3 },
    });
    expect(Object.keys(manifest.sidecar.executable).sort()).toEqual([
      "win32-x64",
    ]);
    expect(manifest.contributions).toContainEqual(
      expect.objectContaining({ type: "capability", id: "execution-domain:dsh" })
    );
  });

  it("keeps the resident runtime boundary UI-neutral and package paths stable", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../../manifest.json", import.meta.url), "utf8")
    );

    expect(manifest.sidecar.resident).toBe(true);
    expect(manifest).not.toHaveProperty("ui");
    expect(manifest).not.toHaveProperty("webUi");
    expect(Object.keys(manifest.settingsSchema.properties).sort()).toEqual([
      "idleGraceSeconds",
      "prewarm",
    ]);
    expect(manifest.settingsSchema.properties).toMatchObject({
      prewarm: { default: false },
      idleGraceSeconds: { default: 600 },
    });
    expect(manifest.sidecar.executable).toEqual({
      "win32-x64": "bin/win32-x64/aio-dsh-supervisor.exe",
    });
    expect(manifest.contributions).toContainEqual(
      expect.objectContaining(DSH_CAPABILITY)
    );
    expect(manifest.methods).toContainEqual(
      expect.objectContaining({ name: "shutdown" })
    );
  });

  it("declares facade-compatible parameters for every runtime method", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../../manifest.json", import.meta.url), "utf8")
    );
    const expected = {
      initialize: ["hostApiVersion", "platform", "pluginDataDir", "prewarm"],
      acquireSession: [
        "domainGenerationId",
        "contractHash",
        "sessionId",
        "viewId",
        "requestedMode",
      ],
      transferController: [
        "domainGenerationId",
        "contractHash",
        "sessionId",
        "leaseId",
        "mode",
        "targetViewId",
      ],
      command: ["lease", "command"],
      snapshot: ["sessionId", "cursor"],
      shutdown: ["reason"],
    };

    for (const [name, parameterNames] of Object.entries(expected)) {
      const method = manifest.methods.find((item) => item.name === name);
      expect(method, `missing method ${name}`).toBeDefined();
      expect(
        method.parameters.map((parameter) => parameter.name)
      ).toEqual(parameterNames);
      for (const parameter of method.parameters) {
        expect(parameter.type).toEqual(expect.any(String));
        const isOptionalCursor =
          name === "snapshot" && parameter.name === "cursor";
        expect(parameter.required ?? true).toBe(!isOptionalCursor);
      }
    }
  });
});
