import type { ContextCapsule } from "./context-capsule";
import type { ModelSelection } from "./read-only-request";

export type StoredSideChatMessage = {
  role: "user" | "assistant";
  content: string;
  /** Capsule revision under which the message was produced (answers only). */
  capsuleRevision?: string;
};

export type SideChat = {
  chatId: string;
  sessionId: string;
  title?: string;
  messages: StoredSideChatMessage[];
  capsule?: ContextCapsule;
  capsuleStale: boolean;
  modelSelection: ModelSelection;
};

export type CreateOutcome =
  | { ok: true; chatId: string }
  | { ok: false; reason: { code: "LIMIT_REACHED"; message: string } };

const TITLE_BOUND = 28;

function autoTitle(question: string): string {
  const text = question.trim();
  return text.length > TITLE_BOUND ? `${text.slice(0, TITLE_BOUND)}…` : text;
}

/**
 * Process-memory side chats only. Nothing here persists, and no cleanup ever
 * writes records to DSH history or AIO chat storage.
 */
export function createSideChatStore(options: { maxPerSession?: number } = {}) {
  const maxPerSession = options.maxPerSession ?? 3;
  const chats = new Map<string, SideChat>();
  let counter = 0;

  function listFor(sessionId: string): SideChat[] {
    return [...chats.values()].filter((chat) => chat.sessionId === sessionId);
  }

  return {
    create(sessionId: string): CreateOutcome {
      if (listFor(sessionId).length >= maxPerSession) {
        return {
          ok: false,
          reason: {
            code: "LIMIT_REACHED",
            message: `${maxPerSession} side chats are already open for this session. Close one before creating another.`,
          },
        };
      }
      counter += 1;
      const chatId = `side-chat-${counter}`;
      chats.set(chatId, {
        chatId,
        sessionId,
        messages: [],
        capsuleStale: false,
        modelSelection: { modelId: "" },
      });
      return { ok: true, chatId };
    },
    get(chatId: string): SideChat | undefined {
      return chats.get(chatId);
    },
    listFor,
    recordQuestion(chatId: string, text: string): void {
      const chat = chats.get(chatId);
      if (chat === undefined) return;
      chat.messages.push({ role: "user", content: text });
      chat.title ??= autoTitle(text);
    },
    recordAnswer(chatId: string, content: string, capsuleRevision?: string): void {
      const chat = chats.get(chatId);
      if (chat === undefined) return;
      chat.messages.push({
        role: "assistant",
        content,
        ...(capsuleRevision === undefined ? {} : { capsuleRevision }),
      });
    },
    attachCapsule(chatId: string, capsule: ContextCapsule): void {
      const chat = chats.get(chatId);
      if (chat === undefined) return;
      chat.capsule = capsule;
      chat.capsuleStale = false;
    },
    markMainTaskAdvanced(sessionId: string, revision: string): void {
      for (const chat of listFor(sessionId)) {
        if (chat.capsule === undefined || chat.capsule.pinnedRevision !== revision) {
          chat.capsuleStale = true;
        }
      }
    },
    setModel(chatId: string, selection: ModelSelection): void {
      const chat = chats.get(chatId);
      if (chat !== undefined) chat.modelSelection = { ...selection };
    },
    close(chatId: string): void {
      chats.delete(chatId);
    },
    closeOthers(sessionId: string, keepChatId: string): void {
      for (const chat of listFor(sessionId)) {
        if (chat.chatId !== keepChatId) chats.delete(chat.chatId);
      }
    },
    closeAll(sessionId: string): void {
      for (const chat of listFor(sessionId)) chats.delete(chat.chatId);
    },
    releaseSession(sessionId: string, _hooks?: { onExternalWrite?: (target: string) => void }): void {
      // Memory release only — cleanup records are never written anywhere.
      for (const chat of listFor(sessionId)) chats.delete(chat.chatId);
    },
    releaseAll(): void {
      chats.clear();
    },
    snapshotForPersistence(): undefined {
      return undefined;
    },
  };
}

export type SideChatStore = ReturnType<typeof createSideChatStore>;
