import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifyRelease } from "./verify-release.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

describe("release verifier", () => {
  it("documents and verifies the Windows x64 first release", async () => {
    const report = await verifyRelease(repositoryRoot);

    expect(report.supported).toEqual(["win32-x64"]);
    expect(report.preview).toEqual([]);
    expect(report.failures).toEqual([]);
  });
});
