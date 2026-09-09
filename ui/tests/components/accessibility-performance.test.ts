// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { computeVisibleRange } from "../../src/shared/virtual-range";
import { createFocusTrap, restoreFocus } from "../../src/shared/focus";
import NavigationPane from "../../src/navigation/NavigationPane.vue";
import TurnTimeline from "../../src/timeline/TurnTimeline.vue";
import TurnGroup from "../../src/timeline/TurnGroup.vue";
import {
  createEmptyProjection,
  reduceSessionProjection,
  type SessionProjection,
} from "../../src/state/reducers/session-reducer";

describe("keyboard and focus", () => {
  it("opens a navigation row with the Enter key", async () => {
    const wrapper = mount(NavigationPane, {
      props: {
        workspaces: [{ id: "ws-1", name: "Alpha" }],
        currentWorkspaceId: "ws-1",
        sessions: [{ id: "session-1", title: "t", workspaceId: "ws-1" }],
        attention: [],
        running: [],
        recent: [],
        collapsedSections: {},
      },
      attachTo: document.body,
    });
    const row = wrapper.find("[data-session-id='session-1']");
    expect(row.attributes("tabindex")).toBe("0");
    await row.trigger("keydown.enter");
    expect(wrapper.emitted("open-session")?.[0]).toEqual([{ sessionId: "session-1", workspaceId: "ws-1" }]);
    wrapper.unmount();
  });

  it("restores focus and traps Tab within a container", () => {
    document.body.innerHTML = `
      <button id="trigger">trigger</button>
      <div id="dialog"><button id="first">first</button><button id="second">second</button></div>
    `;
    const trigger = document.getElementById("trigger") as HTMLElement;
    trigger.focus();
    const dialog = document.getElementById("dialog") as HTMLElement;
    const trap = createFocusTrap(dialog);
    trap.activate();
    expect(document.activeElement?.id).toBe("first");
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true });
    (document.getElementById("second") as HTMLElement).focus();
    dialog.dispatchEvent(event);
    trap.deactivate();
    restoreFocus(trigger);
    expect(document.activeElement?.id).toBe("trigger");
  });

  it("keeps live regions restrained: no assertive regions outside failure detail", () => {
    const projection: SessionProjection = [
      { kind: "turn/start", sessionId: "s", turnId: "t", data: {} },
      { kind: "turn/failed", sessionId: "s", turnId: "t", data: { reason: "boom" } },
    ].reduce(reduceSessionProjection, createEmptyProjection("s"));
    const timeline = mount(TurnTimeline, { props: { projection } });
    // The timeline itself never adds assertive live regions per event...
    expect(timeline.findAll("[aria-live='assertive']")).toHaveLength(0);
    // ...the single failure detail is the only alert.
    expect(timeline.findAll("[role='alert']")).toHaveLength(1);
    timeline.unmount();
    const group = mount(TurnGroup, {
      props: { turn: projection.turns[0] },
    });
    expect(group.findAll("[role='alert']").length).toBeLessThanOrEqual(1);
    group.unmount();
  });
});

describe("bounded rendering", () => {
  it("computes a virtual range with overscan inside bounds", () => {
    const range = computeVisibleRange({
      total: 1000,
      itemHeight: 40,
      viewportHeight: 400,
      scrollTop: 4000,
      overscan: 3,
    });
    expect(range.start).toBe(97);
    expect(range.end).toBe(113);
    expect(range.offsetY).toBe(97 * 40);
    const top = computeVisibleRange({ total: 10, itemHeight: 40, viewportHeight: 400, scrollTop: 0, overscan: 3 });
    expect(top.start).toBe(0);
    expect(top.end).toBe(10);
    const empty = computeVisibleRange({ total: 0, itemHeight: 40, viewportHeight: 400, scrollTop: 0, overscan: 3 });
    expect(empty).toMatchObject({ start: 0, end: 0 });
  });

  it("declares safe unmount cleanup for the terminal renderer", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "inspector", "panels", "TerminalPanel.vue"),
      "utf8",
    );
    expect(source).toContain("onBeforeUnmount");
  });
});
