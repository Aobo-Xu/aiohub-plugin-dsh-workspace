import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { BridgeCommandError } from "../controller-leases.js";

export type AttachmentLimits = {
  maxBytes: number;
  maxCount: number;
  mediaTypes: readonly string[];
};

export type StagedAttachment = {
  attachmentId: string;
  sourcePath: string;
  stagedPath: string;
  mediaType: string;
  bytes: number;
  sha256: string;
};

export function createAttachmentStager(options: {
  root: string;
  limits: AttachmentLimits;
}) {
  const entries = new Map<string, StagedAttachment>();

  return {
    async stage(input: { sourcePath: string; mediaType: string }): Promise<StagedAttachment> {
      if (!options.limits.mediaTypes.includes(input.mediaType)) {
        throw new BridgeCommandError("ATTACHMENT_TYPE_UNSUPPORTED");
      }
      if (entries.size >= options.limits.maxCount) {
        throw new BridgeCommandError("ATTACHMENT_COUNT_EXCEEDED");
      }
      const source = await stat(input.sourcePath);
      if (!source.isFile()) throw new BridgeCommandError("ATTACHMENT_NOT_A_FILE");
      if (source.size > options.limits.maxBytes) {
        throw new BridgeCommandError("ATTACHMENT_TOO_LARGE");
      }
      const attachmentId = randomUUID();
      const stagedPath = join(options.root, attachmentId, basename(input.sourcePath));
      await mkdir(join(options.root, attachmentId), { recursive: true });
      await copyFile(input.sourcePath, stagedPath);
      const bytes = await readFile(stagedPath);
      const staged: StagedAttachment = {
        attachmentId,
        sourcePath: input.sourcePath,
        stagedPath,
        mediaType: input.mediaType,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      entries.set(attachmentId, staged);
      return staged;
    },

    async cleanup(attachmentId: string): Promise<void> {
      const entry = entries.get(attachmentId);
      if (!entry) return;
      entries.delete(attachmentId);
      await rm(join(options.root, attachmentId), { recursive: true, force: true });
    },

    list(): readonly StagedAttachment[] {
      return [...entries.values()];
    },
  };
}
