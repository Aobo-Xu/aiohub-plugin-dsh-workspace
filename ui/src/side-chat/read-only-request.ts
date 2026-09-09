import { renderCapsule, type ContextCapsule } from "./context-capsule";

export type SideChatMessage = { role: "user" | "assistant"; content: string };

export type ModelSelection = { profileId?: string; modelId: string };

export type SideChatRequestInput = {
  capsule: ContextCapsule;
  messages: readonly SideChatMessage[];
  modelSelection: ModelSelection;
  signal?: AbortSignal;
  llmRequest: (options: Record<string, unknown>) => Promise<{ content?: string; toolCalls?: unknown }>;
  /** Accepted only to prove it is never called; side chats never touch it. */
  conversationApi?: { addMessage: (...args: unknown[]) => Promise<unknown> };
};

export type SideChatRequestOutcome =
  | { ok: true; content: string }
  | { ok: false; reason: { code: "READ_ONLY_VIOLATION" | "REQUEST_FAILED"; message: string } };

/**
 * The side-chat execution boundary: text-only, tool-free requests through the
 * AIO LLM API. A tool-bearing response is rejected with a read-only
 * explanation instead of being rendered or executed.
 */
export async function sendSideChatRequest(input: SideChatRequestInput): Promise<SideChatRequestOutcome> {
  const options: Record<string, unknown> = {
    messages: [
      { role: "system", content: renderCapsule(input.capsule) },
      ...input.messages.map((message) => ({ role: message.role, content: message.content })),
    ],
    tools: [],
    toolChoice: "none",
    enableSearch: false,
    enableExecution: false,
    modelId: input.modelSelection.modelId,
    ...(input.modelSelection.profileId === undefined ? {} : { profileId: input.modelSelection.profileId }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  let response: { content?: string; toolCalls?: unknown };
  try {
    response = await input.llmRequest(options);
  } catch (error) {
    return {
      ok: false,
      reason: { code: "REQUEST_FAILED", message: (error as Error | undefined)?.message ?? "request failed" },
    };
  }
  const toolCalls = response?.toolCalls;
  if (Array.isArray(toolCalls) ? toolCalls.length > 0 : toolCalls !== undefined && toolCalls !== null) {
    return {
      ok: false,
      reason: {
        code: "READ_ONLY_VIOLATION",
        message: "Side Chat is read-only: the model proposed a tool call, which was rejected.",
      },
    };
  }
  return { ok: true, content: response?.content ?? "" };
}
