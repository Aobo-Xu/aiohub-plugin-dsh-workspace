// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import TurnTimeline from "../../src/timeline/TurnTimeline.vue";
import { useTailFollow } from "../../src/timeline/use-tail-follow";
import {
  reduceSessionProjection,
  createEmptyProjection,
  type SessionProjection,
} from "../../src/state/reducers/session-reducer";
import type { RuntimeEvent } from "@aiohub/dsh-runtime-facade/types";

function buildProjection(events: readonly RuntimeEvent[]): SessionProjection {
  return events.reduce<SessionProjection>(
    (projection, event) => reduceSessionProjection(projection, event),
    createEmptyProjection("session-1"),
  );
}

const COMPLETED_TURN: readonly RuntimeEvent[] = [
  { kind: "turn/start", sessionId: "session-1", turnId: "turn-1", data: { at: 1_000 } },
  {
    kind: "user/message",
    sessionId: "session-1",
    turnId: "turn-1",
    data: { content: [{ type: "text", text: "Please refactor auth" }] },
  },
  { kind: "tool/call", sessionId: "session-1", turnId: "turn-1", data: { name: "shell", status: "success" } },
  {
    kind: "assistant/message",
    sessionId: "session-1",
    turnId: "turn-1",
    data: {
      content: [{ type: "text", text: "Refactor done" }],
      model: "deepseek-chat",
      source: "deepseek",
      preset: "coding-default",
    },
  },
  { kind: "turn/completed", sessionId: "session-1", turnId: "turn-1", data: { at: 6_000 } },
];

function setScrollMetrics(element: Element, metrics: { scrollHeight: number; scrollTop: number; clientHeight: number }) {
  for (const [key, value] of Object.entries(metrics)) {
    // writable: the component assigns scrollTop when following the tail,
    // mirroring real browser behavior.
    Object.defineProperty(element, key, { configurable: true, writable: true, value });
  }
  element.dispatchEvent(new Event("scroll"));
}

describe("TurnTimeline grouping and disclosure", () => {
  it("groups user input, work process and final response into one Turn", () => {
    const wrapper = mount(TurnTimeline, { props: { projection: buildProjection(COMPLETED_TURN) } });
    const groups = wrapper.findAll("[data-testid='turn-group']");
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group.attributes("data-turn-id")).toBe("turn-1");
    expect(group.find("[data-testid='turn-user-input']").text()).toContain("Please refactor auth");
    expect(group.find("[data-testid='turn-final-response']").text()).toContain("Refactor done");
    expect(group.find("[data-testid='turn-status']").text()).toContain("Completed");
    wrapper.unmount();
  });

  it("shows non-zero event counts and elapsed duration from Host timestamps", () => {
    const wrapper = mount(TurnTimeline, { props: { projection: buildProjection(COMPLETED_TURN) } });
    const group = wrapper.find("[data-testid='turn-group']");
    expect(Number(group.find("[data-testid='turn-event-count']").text())).toBe(5);
    expect(group.find("[data-testid='turn-duration']").text()).toContain("5");
    wrapper.unmount();
  });

  it("keeps the process collapsed for a completed Turn and expanded for a failed one", async () => {
    const completed = mount(TurnTimeline, { props: { projection: buildProjection(COMPLETED_TURN) } });
    const toggle = completed.find("[data-testid='process-toggle']");
    expect(toggle.attributes("aria-expanded")).toBe("false");
    expect(completed.find("[data-testid='process-card']").exists()).toBe(false);
    await toggle.trigger("click");
    expect(completed.find("[data-testid='process-card']").exists()).toBe(true);
    completed.unmount();

    const failed = mount(
      TurnTimeline,
      {
        props: {
          projection: buildProjection([
            { kind: "turn/start", sessionId: "session-1", turnId: "turn-2", data: {} },
            { kind: "tool/call", sessionId: "session-1", turnId: "turn-2", data: { name: "shell" } },
            { kind: "turn/failed", sessionId: "session-1", turnId: "turn-2", data: { reason: "model overloaded" } },
          ]),
        },
      },
    );
    const failedGroup = failed.find("[data-testid='turn-group']");
    expect(failedGroup.find("[data-testid='process-toggle']").attributes("aria-expanded")).toBe("true");
    expect(failedGroup.text()).toContain("model overloaded");
    failed.unmount();
  });

  it("keeps historical provenance and never relabels it with the current selection", () => {
    const wrapper = mount(TurnTimeline, {
      props: {
        projection: buildProjection(COMPLETED_TURN),
        currentSelection: { model: "deepseek-reasoner", source: "other-provider" },
      },
    });
    const provenance = wrapper.find("[data-testid='turn-provenance']");
    expect(provenance.text()).toContain("deepseek-chat");
    expect(provenance.text()).not.toContain("deepseek-reasoner");
    wrapper.unmount();
  });

  it("renders stable source anchors that survive remounting", () => {
    const projection = buildProjection(COMPLETED_TURN);
    const first = mount(TurnTimeline, { props: { projection } });
    const anchors = first.findAll("[data-anchor-id]").map((card) => card.attributes("data-anchor-id"));
    first.unmount();
    const second = mount(TurnTimeline, { props: { projection } });
    const remounted = second.findAll("[data-anchor-id]").map((card) => card.attributes("data-anchor-id"));
    second.unmount();
    expect(anchors.length).toBeGreaterThan(0);
    expect(remounted).toEqual(anchors);
  });
});

describe("TurnTimeline tail following", () => {
  it("follows near the bottom and exposes a new-content control while reading history", async () => {
    const wrapper = mount(TurnTimeline, {
      props: { projection: buildProjection(COMPLETED_TURN) },
      attachTo: document.body,
    });
    const scroll = wrapper.find("[data-testid='timeline-scroll']").element;

    setScrollMetrics(scroll, { scrollHeight: 1000, scrollTop: 0, clientHeight: 200 });
    wrapper.setProps({
      projection: buildProjection([
        ...COMPLETED_TURN,
        { kind: "turn/start", sessionId: "session-1", turnId: "turn-9", data: {} },
      ]),
    });
    await nextTick();
    expect(wrapper.find("[data-testid='new-content']").exists()).toBe(true);

    await wrapper.find("[data-testid='new-content']").trigger("click");
    await nextTick();
    expect(wrapper.find("[data-testid='new-content']").exists()).toBe(false);

    // Near the bottom, streaming content stays followed without the control.
    setScrollMetrics(scroll, { scrollHeight: 1000, scrollTop: 780, clientHeight: 200 });
    wrapper.setProps({
      projection: buildProjection([
        ...COMPLETED_TURN,
        { kind: "turn/start", sessionId: "session-1", turnId: "turn-10", data: {} },
      ]),
    });
    await nextTick();
    expect(wrapper.find("[data-testid='new-content']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps pure follow state transitions deterministic", () => {
    const follow = useTailFollow({ threshold: 80 });
    expect(follow.following.value).toBe(true);
    follow.updateFromMetrics({ scrollHeight: 1000, scrollTop: 0, clientHeight: 200 });
    expect(follow.following.value).toBe(false);
    follow.noteContentGrown();
    expect(follow.pendingCount.value).toBe(1);
    follow.updateFromMetrics({ scrollHeight: 1000, scrollTop: 760, clientHeight: 200 });
    expect(follow.following.value).toBe(true);
    expect(follow.pendingCount.value).toBe(0);
  });
});
