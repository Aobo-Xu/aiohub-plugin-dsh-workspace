// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createSideChatStore } from "../../src/side-chat/side-chat-store";
import { buildCapsule } from "../../src/side-chat/context-capsule";
import SideChatPanel from "../../src/side-chat/SideChatPanel.vue";
import CloseSideChatDialog from "../../src/side-chat/CloseSideChatDialog.vue";

function capsule(revision = "rev-1") {
  return buildCapsule(
    "session-1",
    { anchor: { kind: "selection", id: "a-1", sessionId: "session-1", excerpt: "code" }, summary: "ctx" },
    { mainStateRevision: revision },
  );
}

describe("side-chat store lifecycle", () => {
  it("creates up to three in-memory chats per session with automatic titles", () => {
    const store = createSideChatStore();
    const first = store.create("session-1");
    expect(first.ok).toBe(true);
    const second = store.create("session-1");
    const third = store.create("session-1");
    expect(second.ok && third.ok).toBe(true);
    const fourth = store.create("session-1");
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) {
      expect(fourth.reason.code).toBe("LIMIT_REACHED");
      expect(fourth.reason.message.length).toBeGreaterThan(0);
    }
    // Another main session has its own budget.
    expect(store.create("session-2").ok).toBe(true);

    if (first.ok) {
      store.recordQuestion(first.chatId, "Why does the auth test flake and retry?");
      const chat = store.get(first.chatId);
      expect(chat?.title).toBe("Why does the auth test flake…");
      expect(chat?.title?.length).toBeLessThanOrEqual(30);
    }
  });

  it("keeps model selections independent per chat and per session model untouched", () => {
    const store = createSideChatStore();
    const a = store.create("session-1");
    const b = store.create("session-1");
    if (a.ok && b.ok) {
      store.setModel(a.chatId, { profileId: "p1", modelId: "deepseek-chat" });
      store.setModel(b.chatId, { profileId: "p2", modelId: "deepseek-reasoner" });
      expect(store.get(a.chatId)?.modelSelection.modelId).toBe("deepseek-chat");
      expect(store.get(b.chatId)?.modelSelection.modelId).toBe("deepseek-reasoner");
    }
    // The store exposes no API touching the DSH session model or preset.
    expect(Object.keys(store)).not.toContain("setSessionModel");
  });

  it("pins capsule freshness, marks stale on main-task advance and keeps provenance per answer", () => {
    const store = createSideChatStore();
    const chat = store.create("session-1");
    if (!chat.ok) throw new Error("unreachable");
    store.attachCapsule(chat.chatId, capsule("rev-1"));
    store.recordAnswer(chat.chatId, "answer under rev-1", "rev-1");
    store.markMainTaskAdvanced("session-1", "rev-2");
    expect(store.get(chat.chatId)?.capsuleStale).toBe(true);
    store.attachCapsule(chat.chatId, capsule("rev-2"));
    expect(store.get(chat.chatId)?.capsuleStale).toBe(false);
    store.recordAnswer(chat.chatId, "answer under rev-2", "rev-2");
    const messages = store.get(chat.chatId)?.messages ?? [];
    const answers = messages.filter((message) => message.role === "assistant");
    expect(answers[0].capsuleRevision).toBe("rev-1");
    expect(answers[1].capsuleRevision).toBe("rev-2");
  });

  it("closes one/others/all without touching other tab types and never persists", () => {
    const store = createSideChatStore();
    const a = store.create("session-1");
    const b = store.create("session-1");
    const c = store.create("session-1");
    if (!(a.ok && b.ok && c.ok)) throw new Error("unreachable");
    store.closeOthers("session-1", a.chatId);
    expect(store.listFor("session-1").map((chat) => chat.chatId)).toEqual([a.chatId]);
    store.closeAll("session-1");
    expect(store.listFor("session-1")).toEqual([]);
    expect(store.listFor("session-2")).toBeDefined();
    expect(store.snapshotForPersistence()).toBeUndefined();
  });

  it("releases memory on confirmed session deletion and plugin unload without cleanup records", () => {
    const store = createSideChatStore();
    const a = store.create("session-1");
    const b = store.create("session-2");
    if (!(a.ok && b.ok)) throw new Error("unreachable");
    const writes: string[] = [];
    store.releaseSession("session-1", { onExternalWrite: (target) => writes.push(target) });
    expect(store.listFor("session-1")).toEqual([]);
    expect(store.listFor("session-2")).toHaveLength(1);
    store.releaseAll();
    expect(store.listFor("session-2")).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe("SideChatPanel", () => {
  function mountPanel(props: Record<string, unknown> = {}) {
    const store = createSideChatStore();
    const chat = store.create("session-1");
    if (!chat.ok) throw new Error("unreachable");
    store.attachCapsule(chat.chatId, capsule());
    store.recordQuestion(chat.chatId, "What changed?");
    store.recordAnswer(chat.chatId, "The auth module changed.", "rev-1");
    return mount(SideChatPanel, {
      props: { chat: store.get(chat.chatId)!, capsuleStale: false, ...props },
    });
  }

  it("shows the stale badge when the main task advanced", () => {
    const fresh = mountPanel();
    expect(fresh.find("[data-testid='capsule-stale-badge']").exists()).toBe(false);
    fresh.unmount();
    const stale = mountPanel({ capsuleStale: true });
    expect(stale.find("[data-testid='capsule-stale-badge']").exists()).toBe(true);
    expect(stale.find("[data-testid='capsule-refresh']").exists()).toBe(true);
    stale.unmount();
  });

  it("offers explicit copy and insert-as-draft only, never auto-submit", async () => {
    const wrapper = mountPanel();
    const answer = wrapper.find("[data-testid='side-chat-answer']");
    expect(answer.text()).toContain("auth module changed");
    await answer.find("[data-testid='answer-copy']").trigger("click");
    expect(wrapper.emitted("copy")?.[0]?.[0]).toContain("auth module changed");
    await answer.find("[data-testid='answer-insert-draft']").trigger("click");
    expect(wrapper.emitted("insert-draft")?.[0]?.[0]).toContain("auth module changed");
    expect(wrapper.emitted("submit-to-main")).toBeUndefined();
    wrapper.unmount();
  });
});

describe("CloseSideChatDialog", () => {
  it("discloses irreversible deletion with cancel, close and UI-only suppression", async () => {
    const wrapper = mount(CloseSideChatDialog, {
      props: { open: true, scope: "one", chatTitle: "Why does the auth…" },
    });
    expect(wrapper.text()).toContain("deleted");
    expect(wrapper.text()).toContain("cannot be recovered");
    await wrapper.find("[data-testid='close-cancel']").trigger("click");
    expect(wrapper.emitted("cancel")).toBeTruthy();
    await wrapper.find("[data-testid='close-suppress']").setValue(true);
    await wrapper.find("[data-testid='close-confirm']").trigger("click");
    expect(wrapper.emitted("confirm")?.[0]).toEqual([{ scope: "one", suppressWarning: true }]);
    wrapper.unmount();
  });
});
