import { describe, expect, it } from "vitest";
import { sendSideChatRequest } from "../../src/side-chat/read-only-request";
import { buildCapsule } from "../../src/side-chat/context-capsule";

function capsule() {
  return buildCapsule(
    "session-1",
    {
      anchor: { kind: "selection", id: "a-1", sessionId: "session-1", excerpt: "code" },
      summary: "context",
    },
    { mainStateRevision: "rev-1" },
  );
}

describe("side-chat read-only request boundary", () => {
  it("sends text-only options with tools disabled and signal propagated", async () => {
    const requests: Record<string, unknown>[] = [];
    const controller = new AbortController();
    const outcome = await sendSideChatRequest({
      capsule: capsule(),
      messages: [{ role: "user", content: "What changed?" }],
      modelSelection: { profileId: "profile-1", modelId: "deepseek-chat" },
      signal: controller.signal,
      llmRequest: (options: Record<string, unknown>) => {
        requests.push(options);
        return Promise.resolve({ content: "The auth module changed." });
      },
      conversationApi: { addMessage: () => Promise.resolve() },
    });
    expect(outcome.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].tools).toEqual([]);
    expect(requests[0].toolChoice).toBe("none");
    expect(requests[0].enableSearch).toBe(false);
    expect(requests[0].enableExecution).toBe(false);
    expect(requests[0].signal).toBe(controller.signal);
    expect(requests[0].modelId).toBe("deepseek-chat");
    if (outcome.ok) expect(outcome.content).toContain("auth module");
  });

  it("never calls AIO conversation storage APIs", async () => {
    let conversationCalls = 0;
    await sendSideChatRequest({
      capsule: capsule(),
      messages: [{ role: "user", content: "hi" }],
      modelSelection: { modelId: "deepseek-chat" },
      llmRequest: () => Promise.resolve({ content: "hello" }),
      conversationApi: {
        addMessage: () => {
          conversationCalls += 1;
          return Promise.resolve();
        },
      },
    });
    expect(conversationCalls).toBe(0);
  });

  it("rejects a tool-bearing response with a read-only explanation", async () => {
    const outcome = await sendSideChatRequest({
      capsule: capsule(),
      messages: [{ role: "user", content: "delete things" }],
      modelSelection: { modelId: "deepseek-chat" },
      llmRequest: () =>
        Promise.resolve({ content: "sure", toolCalls: [{ name: "shell", arguments: {} }] }),
      conversationApi: { addMessage: () => Promise.resolve() },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason.code).toBe("READ_ONLY_VIOLATION");
      expect(outcome.reason.message).toContain("read-only");
    }
  });

  it("surfaces transport failures without content", async () => {
    const outcome = await sendSideChatRequest({
      capsule: capsule(),
      messages: [{ role: "user", content: "hi" }],
      modelSelection: { modelId: "deepseek-chat" },
      llmRequest: () => Promise.reject(new Error("network down")),
      conversationApi: { addMessage: () => Promise.resolve() },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason.code).toBe("REQUEST_FAILED");
  });
});
