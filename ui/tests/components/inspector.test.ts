// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createInspectorStore } from "../../src/inspector/inspector-store";
import { PANEL_DESCRIPTORS, availablePanelTypes } from "../../src/inspector/panel-registry";
import { navigateResource } from "../../src/inspector/resource-navigator";
import InspectorHost from "../../src/inspector/InspectorHost.vue";

function availability(capabilities: readonly string[]) {
  return (capabilityId: string) =>
    capabilities.includes(capabilityId) ? { available: true } : { available: false };
}

const FULL_CAPS = [
  "session.snapshot",
  "context.summary",
  "terminal.open",
  "terminal.send",
  "subagent.inspect",
  "session.statistics",
  "goal.manage",
  "file.read",
];

describe("inspector store dynamic tabs", () => {
  it("starts at the zero-tab chooser and creates panels from the + menu contract", () => {
    const store = createInspectorStore({ descriptors: PANEL_DESCRIPTORS, availability: availability(FULL_CAPS) });
    expect(store.tabsFor("session-1")).toEqual([]);
    const opened = store.openPanel("session-1", { panelType: "details" });
    expect(opened.ok).toBe(true);
    expect(store.tabsFor("session-1")).toHaveLength(1);
  });

  it("only offers currently creatable panel types", () => {
    const limited = availablePanelTypes(PANEL_DESCRIPTORS, availability(["session.snapshot"]));
    expect(limited.map((descriptor) => descriptor.panelType)).toContain("details");
    expect(limited.map((descriptor) => descriptor.panelType)).not.toContain("terminal");
  });

  it("focuses a matching existing tab instead of duplicating singletons", () => {
    const store = createInspectorStore({ descriptors: PANEL_DESCRIPTORS, availability: availability(FULL_CAPS) });
    const first = store.openPanel("session-1", { panelType: "details" });
    const second = store.openPanel("session-1", { panelType: "details" });
    expect(store.tabsFor("session-1")).toHaveLength(1);
    if (first.ok && second.ok) {
      expect(second.tabId).toBe(first.tabId);
    }
    expect(store.activeTabId("session-1")).toBe(second.ok ? second.tabId : undefined);
  });

  it("limits terminal and subagent panels to three instances per session", () => {
    const store = createInspectorStore({ descriptors: PANEL_DESCRIPTORS, availability: availability(FULL_CAPS) });
    for (const index of [1, 2, 3]) {
      const opened = store.openPanel("session-1", {
        panelType: "terminal",
        resourceRef: { kind: "terminal", id: `term-${index}` },
      });
      expect(opened.ok, `terminal ${index}`).toBe(true);
    }
    const fourth = store.openPanel("session-1", {
      panelType: "terminal",
      resourceRef: { kind: "terminal", id: "term-4" },
    });
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.reason.code).toBe("INSTANCE_LIMIT");
    expect(store.tabsFor("session-1").filter((tab) => tab.panelType === "terminal")).toHaveLength(3);
  });

  it("supports pinning and keeps tabs isolated per session", () => {
    const store = createInspectorStore({ descriptors: PANEL_DESCRIPTORS, availability: availability(FULL_CAPS) });
    const a = store.openPanel("session-1", { panelType: "details" });
    store.openPanel("session-2", { panelType: "files", resourceRef: { kind: "file", id: "f-1" } });
    if (a.ok) {
      store.togglePin("session-1", a.tabId);
      expect(store.tabsFor("session-1")[0].pinned).toBe(true);
    }
    expect(store.tabsFor("session-1").every((tab) => tab.sessionId === "session-1")).toBe(true);
    expect(store.tabsFor("session-2")).toHaveLength(1);
    store.switchSession("session-2");
    expect(store.activeSessionId()).toBe("session-2");
    // Session 1 tabs never move or leak into session 2.
    expect(store.tabsFor("session-2").every((tab) => tab.sessionId === "session-2")).toBe(true);
  });

  it("returns to the chooser when the last tab closes without touching Host work", () => {
    const store = createInspectorStore({ descriptors: PANEL_DESCRIPTORS, availability: availability(FULL_CAPS) });
    const opened = store.openPanel("session-1", { panelType: "details" });
    if (opened.ok) store.closeTab("session-1", opened.tabId);
    expect(store.tabsFor("session-1")).toEqual([]);
    expect(store.chooserVisible("session-1")).toBe(true);
  });

  it("fails closed when the capability for a panel was not negotiated", () => {
    const store = createInspectorStore({ descriptors: PANEL_DESCRIPTORS, availability: availability([]) });
    const opened = store.openPanel("session-1", { panelType: "terminal", resourceRef: { kind: "terminal", id: "t" } });
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.reason.code).toBe("CAPABILITY_UNAVAILABLE");
  });
});

describe("resource navigator", () => {
  it("focuses a compatible panel or creates one preserving provenance", () => {
    const store = createInspectorStore({ descriptors: PANEL_DESCRIPTORS, availability: availability(FULL_CAPS) });
    const first = navigateResource(store, "session-1", {
      kind: "diff",
      id: "diff-1",
      revision: "rev-1",
      intent: "open",
    });
    expect(first.ok).toBe(true);
    const again = navigateResource(store, "session-1", {
      kind: "diff",
      id: "diff-1",
      revision: "rev-1",
      intent: "open",
    });
    if (first.ok && again.ok) expect(again.tabId).toBe(first.tabId);
    const tab = store.tabsFor("session-1").find((candidate) => candidate.panelType === "diff");
    expect(tab?.resourceRef).toMatchObject({ kind: "diff", id: "diff-1", revision: "rev-1" });
  });

  it("falls back to a bounded generic panel for unknown resource types without reading them", () => {
    const store = createInspectorStore({ descriptors: PANEL_DESCRIPTORS, availability: availability(FULL_CAPS) });
    const result = navigateResource(store, "session-1", {
      kind: "custom-host-resource",
      id: "res-9",
      intent: "open",
    });
    expect(result.ok).toBe(true);
    const tab = store.tabsFor("session-1")[0];
    expect(tab.panelType).toBe("generic");
    expect(tab.resourceRef?.kind).toBe("custom-host-resource");
  });
});

describe("InspectorHost presentation", () => {
  function mountHost(props: Record<string, unknown> = {}) {
    return mount(InspectorHost, {
      props: {
        sessionId: "session-1",
        descriptors: PANEL_DESCRIPTORS,
        availability: availability(FULL_CAPS),
        narrow: false,
        ...props,
      },
    });
  }

  it("shows the direct chooser at zero tabs and the + menu afterwards", async () => {
    const wrapper = mountHost();
    expect(wrapper.find("[data-testid='inspector-chooser']").exists()).toBe(true);
    await wrapper.find("[data-testid='choose-details']").trigger("click");
    expect(wrapper.find("[data-testid='inspector-tab']").exists()).toBe(true);
    await wrapper.find("[data-testid='add-tab']").trigger("click");
    expect(wrapper.find("[data-testid='add-menu']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("presents docked by default and overlay when narrow, without split/float controls", () => {
    const docked = mountHost();
    expect(docked.find("[data-testid='inspector-docked']").exists()).toBe(true);
    expect(docked.find("[data-testid='inspector-overlay']").exists()).toBe(false);
    docked.unmount();
    const narrow = mountHost({ narrow: true });
    expect(narrow.find("[data-testid='inspector-overlay']").exists()).toBe(true);
    // First release ships no split panes or floating panels.
    expect(narrow.find("[data-testid='split-control']").exists()).toBe(false);
    expect(narrow.find("[data-testid='float-control']").exists()).toBe(false);
    narrow.unmount();
  });

  it("closes the last tab back to the chooser", async () => {
    const wrapper = mountHost();
    await wrapper.find("[data-testid='choose-details']").trigger("click");
    await wrapper.find("[data-testid='tab-close']").trigger("click");
    expect(wrapper.find("[data-testid='inspector-chooser']").exists()).toBe(true);
    wrapper.unmount();
  });
});
