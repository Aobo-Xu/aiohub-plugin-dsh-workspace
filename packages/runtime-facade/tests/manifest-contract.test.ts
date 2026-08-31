import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DSH_CAPABILITY } from "../src/types.js";

describe("DSH manifest contract", () => {
  it("declares a resident API v3 DSH execution domain on four packaged platforms", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../../manifest.json", import.meta.url), "utf8")
    );

    expect(manifest).toMatchObject({
      id: "dsh-coding-workspace",
      type: "sidecar",
      host: { apiVersion: 3 },
    });
    expect(Object.keys(manifest.sidecar.executable).sort()).toEqual([
      "darwin-arm64",
      "linux-arm64",
      "linux-x64",
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
      "linux-x64": "bin/linux-x64/aio-dsh-supervisor",
      "darwin-arm64": "bin/darwin-arm64/aio-dsh-supervisor",
      "linux-arm64": "bin/linux-arm64/aio-dsh-supervisor",
    });
    expect(manifest.contributions).toContainEqual(
      expect.objectContaining(DSH_CAPABILITY)
    );
  });
});
