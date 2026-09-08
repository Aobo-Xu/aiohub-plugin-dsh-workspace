import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttachmentStager } from "../src/artifacts/attachments.js";
import { createDiffArtifactService } from "../src/artifacts/diffs.js";
import { normalizePresenter } from "../src/presenters/normalize-presenter.js";

describe("DSH interaction artifacts", () => {
  it("stages accepted attachments with a hash and cleans them without touching source", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-attachments-"));
    const sourcePath = join(root, "source.txt");
    await writeFile(sourcePath, "safe");
    const stager = createAttachmentStager({
      root: join(root, "staging"),
      limits: { maxBytes: 8, maxCount: 2, mediaTypes: ["text/plain"] },
    });

    const staged = await stager.stage({ sourcePath, mediaType: "text/plain" });
    expect(staged.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(sourcePath, "utf8")).toBe("safe");
    expect(await readFile(staged.stagedPath, "utf8")).toBe("safe");

    await stager.cleanup(staged.attachmentId);
    await expect(access(staged.stagedPath)).rejects.toThrow();
  });

  it("rejects an attachment that exceeds the advertised limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-attachments-"));
    const sourcePath = join(root, "large.txt");
    await writeFile(sourcePath, "too-large");
    const stager = createAttachmentStager({
      root: join(root, "staging"),
      limits: { maxBytes: 4, maxCount: 1, mediaTypes: ["text/plain"] },
    });

    await expect(stager.stage({ sourcePath, mediaType: "text/plain" })).rejects.toMatchObject({
      code: "ATTACHMENT_TOO_LARGE",
    });
  });

  it("keeps a diff reviewable while fail-closing apply", async () => {
    const service = createDiffArtifactService({
      operationAvailability: (id) => id === "artifact.diff.review"
        ? { available: true }
        : { available: false, reason: { code: "CAPABILITY_NOT_NEGOTIATED" } },
    });
    const diff = await service.review({
      workspaceId: "workspace-1",
      path: "src/app.ts",
      base: "HEAD",
      revision: "worktree",
      content: "@@ -1 +1 @@",
      snapshotId: "snapshot-1",
    });
    expect(diff.provenance.snapshotId).toBe("snapshot-1");
    await expect(service.apply(diff)).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capabilityId: "artifact.diff.apply",
    });
  });

  it("masks unknown presenter data and exposes no unsafe actions", () => {
    const presenter = normalizePresenter({
      kind: "future/runtime-event",
      data: { token: "secret-value", path: "C:\\Users\\Lenovo\\private.txt" },
      provenance: { source: "dsh", model: "deepseek-v4-flash" },
      operations: { "artifact.open": true },
    });
    expect(presenter.kind).toBe("unknown:future/runtime-event");
    expect(presenter.actions).toEqual([]);
    expect(presenter.data).toMatchObject({ token: "***", path: "<path>" });
  });
});
