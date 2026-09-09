import type { AttachmentDraft } from "./command-gate";

export type ComposerDraft = {
  text: string;
  attachments: AttachmentDraft[];
};

/**
 * Bounded per-session drafts in process memory only. Drafts survive session
 * navigation and pending control transfers, and are cleared only after a
 * successful submission. Nothing here may reach DSH history or AIO chat
 * persistence; snapshotForPersistence() is intentionally always undefined.
 */
export function createDraftStore() {
  const drafts = new Map<string, ComposerDraft>();

  return {
    get(sessionId: string): ComposerDraft | undefined {
      const draft = drafts.get(sessionId);
      return draft === undefined ? undefined : { text: draft.text, attachments: [...draft.attachments] };
    },
    set(sessionId: string, draft: ComposerDraft): void {
      drafts.set(sessionId, { text: draft.text, attachments: [...draft.attachments] });
    },
    clear(sessionId: string): void {
      drafts.delete(sessionId);
    },
    /** Navigation never clears drafts; kept explicit for call-site intent. */
    noteSessionSwitch(_sessionId: string): void {},
    /** Pending transfers fence mutations but never touch drafts. */
    noteTransferPending(_sessionId: string): void {},
    markSubmitted(sessionId: string, succeeded: boolean): void {
      if (succeeded) {
        drafts.delete(sessionId);
      }
    },
    snapshotForPersistence(): undefined {
      return undefined;
    },
    sessionIds(): string[] {
      return [...drafts.keys()];
    },
  };
}

export type DraftStore = ReturnType<typeof createDraftStore>;
