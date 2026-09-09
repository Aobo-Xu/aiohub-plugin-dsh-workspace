// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import SessionComposer from "../../src/composer/SessionComposer.vue";
import GoalStatusStrip from "../../src/composer/GoalStatusStrip.vue";
import InteractionCard from "../../src/interactions/InteractionCard.vue";
import NeedAttention from "../../src/interactions/NeedAttention.vue";
import GoalPanel from "../../src/inspector/panels/GoalPanel.vue";

describe("SessionComposer", () => {
  function mountComposer(props: Record<string, unknown> = {}) {
    return mount(SessionComposer, {
      props: {
        sessionId: "session-1",
        canSubmit: true,
        busy: false,
        queueAvailable: true,
        steerAvailable: true,
        busyPreference: undefined,
        attachmentLimits: { maxCount: 2, maxBytes: 1024, mediaTypes: ["text/plain"] },
        ...props,
      },
    });
  }

  it("routes the send button and Enter to the same action", async () => {
    const wrapper = mountComposer();
    await wrapper.find("[data-testid='composer-input']").setValue("do the thing");
    await wrapper.find("[data-testid='composer-send']").trigger("click");
    const viaButton = wrapper.emitted("submit");
    expect(viaButton?.[0]?.[0]).toMatchObject({ text: "do the thing", action: "submit" });

    const second = mountComposer();
    await second.find("[data-testid='composer-input']").setValue("do the thing");
    await second.find("[data-testid='composer-form']").trigger("submit");
    expect(second.emitted("submit")?.[0]?.[0]).toMatchObject({ text: "do the thing", action: "submit" });
    wrapper.unmount();
    second.unmount();
  });

  it("shows queue as busy default, steer as explicit choice, and single actions alone", () => {
    const both = mountComposer({ busy: true });
    expect(both.find("[data-testid='composer-send']").text()).toContain("Queue");
    expect(both.find("[data-testid='composer-steer']").exists()).toBe(true);
    both.unmount();

    const preferred = mountComposer({ busy: true, busyPreference: "steer" });
    expect(preferred.find("[data-testid='composer-send']").text()).toContain("Steer");
    preferred.unmount();

    const onlyQueue = mountComposer({ busy: true, steerAvailable: false });
    expect(onlyQueue.find("[data-testid='composer-steer']").exists()).toBe(false);
    onlyQueue.unmount();
  });

  it("blocks blank submissions in the UI without emitting", async () => {
    const wrapper = mountComposer();
    await wrapper.find("[data-testid='composer-input']").setValue("   ");
    await wrapper.find("[data-testid='composer-send']").trigger("click");
    expect(wrapper.emitted("submit")).toBeUndefined();
    expect(wrapper.find("[data-testid='composer-empty-hint']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("disables mutations for observers with the controller and transfer visible", () => {
    const wrapper = mountComposer({
      canSubmit: false,
      observer: true,
      controllerLabel: "window-B",
      transferAvailable: true,
    });
    const send = wrapper.find("[data-testid='composer-send']");
    expect((send.element as HTMLButtonElement).disabled).toBe(true);
    expect(wrapper.find("[data-testid='composer-observer-note']").text()).toContain("window-B");
    expect(wrapper.find("[data-testid='composer-request-transfer']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("explains runtime-provided attachment limits", () => {
    const wrapper = mountComposer({
      attachmentLimits: { maxCount: 1, maxBytes: 10, mediaTypes: ["image/png"], supportAdvertised: true },
    });
    expect(wrapper.find("[data-testid='composer-attachment-limits']").text()).toContain("1");
    expect(wrapper.find("[data-testid='composer-attachment-limits']").text()).toContain("image/png");
    wrapper.unmount();
  });
});

describe("GoalStatusStrip", () => {
  const goal = {
    goalId: "goal-1",
    phase: "executing",
    objective: "Ship the release gate",
    progress: { done: 3, total: 5 },
    revision: 7,
    paused: false,
    resumeAvailable: false,
  };

  it("shows phase, objective and bounded progress and opens the Inspector panel", async () => {
    const wrapper = mount(GoalStatusStrip, { props: { goal } });
    expect(wrapper.find("[data-testid='goal-phase']").text()).toBe("executing");
    expect(wrapper.text()).toContain("Ship the release gate");
    expect(wrapper.find("[data-testid='goal-progress']").text()).toContain("3/5");
    await wrapper.find("[data-testid='goal-strip']").trigger("click");
    expect(wrapper.emitted("open-goal")?.[0]).toEqual([goal]);
    wrapper.unmount();
  });

  it("offers exactly one user-owned resume for a paused Goal when advertised", async () => {
    const paused = { ...goal, paused: true, resumeAvailable: true };
    const wrapper = mount(GoalStatusStrip, { props: { goal: paused } });
    const resume = wrapper.find("[data-testid='goal-resume']");
    expect(resume.exists()).toBe(true);
    await resume.trigger("click");
    expect(wrapper.emitted("resume-goal")).toHaveLength(1);
    expect(wrapper.emitted("resume-goal")?.[0]).toEqual([{ goalId: "goal-1", revision: 7 }]);
    wrapper.unmount();

    const notAdvertised = mount(GoalStatusStrip, { props: { goal: { ...goal, paused: true } } });
    expect(notAdvertised.find("[data-testid='goal-resume']").exists()).toBe(false);
    notAdvertised.unmount();
  });
});

describe("InteractionCard", () => {
  const approval = {
    correlationId: "int-1",
    kind: "approval" as const,
    scope: "coding-workspace",
    risk: "medium",
    operations: [{ id: "op-1", summary: "write file" }, { id: "op-2", summary: "run test" }],
    choices: ["allow", "deny"],
    state: "pending" as const,
  };

  it("renders one grouped approval with Host scope, risk and choices", async () => {
    const wrapper = mount(InteractionCard, { props: { interaction: approval } });
    expect(wrapper.findAll("[data-testid='interaction-card']")).toHaveLength(1);
    expect(wrapper.text()).toContain("write file");
    expect(wrapper.text()).toContain("run test");
    expect(wrapper.find("[data-testid='interaction-scope']").text()).toContain("coding-workspace");
    expect(wrapper.find("[data-testid='interaction-risk']").text()).toContain("medium");
    const buttons = wrapper.findAll("[data-testid='interaction-choice']");
    expect(buttons.map((button) => button.text())).toEqual(["allow", "deny"]);
    await buttons[0].trigger("click");
    expect(wrapper.emitted("respond")?.[0]).toEqual([{ correlationId: "int-1", choice: "allow" }]);
    wrapper.unmount();
  });

  it("ignores duplicate clicks while a response is in flight", async () => {
    const wrapper = mount(InteractionCard, { props: { interaction: approval } });
    const button = wrapper.find("[data-testid='interaction-choice']");
    await button.trigger("click");
    await button.trigger("click");
    expect(wrapper.emitted("respond")).toHaveLength(1);
    wrapper.unmount();
  });

  it("converges on terminal states from anywhere and disables responses", () => {
    const wrapper = mount(InteractionCard, {
      props: { interaction: { ...approval, state: "resolved", resolution: "allowed elsewhere" } },
    });
    expect(wrapper.find("[data-testid='interaction-resolution']").text()).toContain("allowed elsewhere");
    const button = wrapper.find("[data-testid='interaction-choice']");
    expect(button.exists() && (button.element as HTMLButtonElement).disabled).toBe(true);
    wrapper.unmount();
  });

  it("keeps the exact question identity", async () => {
    const question = {
      correlationId: "q-9",
      kind: "question" as const,
      promptText: "Which target?",
      choices: ["a", "b"],
      state: "pending" as const,
      operations: [],
    };
    const wrapper = mount(InteractionCard, { props: { interaction: question } });
    await wrapper.findAll("[data-testid='interaction-choice']")[1].trigger("click");
    expect(wrapper.emitted("respond")?.[0]).toEqual([{ correlationId: "q-9", choice: "b" }]);
    wrapper.unmount();
  });
});

describe("GoalPanel capability-backed management", () => {
  const goal = { goalId: "goal-1", text: "Ship it", status: "active", revision: 4 };

  it("renders management controls only when the Host advertises them", async () => {
    const limited = mount(GoalPanel, { props: { goal, capabilities: ["goal.edit"] } });
    expect(limited.find("[data-testid='goal-edit']").exists()).toBe(true);
    expect(limited.find("[data-testid='goal-limits']").exists()).toBe(false);
    expect(limited.find("[data-testid='goal-clear']").exists()).toBe(false);
    limited.unmount();

    const full = mount(GoalPanel, {
      props: { goal, capabilities: ["goal.edit", "goal.limits", "goal.blockers", "goal.clear"] },
    });
    expect(full.find("[data-testid='goal-limits']").exists()).toBe(true);
    expect(full.find("[data-testid='goal-blockers']").exists()).toBe(true);
    await full.find("[data-testid='goal-clear']").trigger("click");
    expect(full.emitted("clear-goal")?.[0]).toEqual([{ goalId: "goal-1", revision: 4 }]);
    full.unmount();
  });

  it("shows the revision and never offers controls without capabilities", () => {
    const wrapper = mount(GoalPanel, { props: { goal, capabilities: [] } });
    expect(wrapper.find("[data-testid='goal-revision']").text()).toContain("4");
    expect(wrapper.find("[data-testid='goal-edit']").exists()).toBe(false);
    wrapper.unmount();
  });
});

describe("NeedAttention", () => {
  it("groups actionable summaries with workspace labels and exact targets", async () => {
    const wrapper = mount(NeedAttention, {
      props: {
        items: [
          { correlationId: "int-1", kind: "approval", workspaceId: "ws-1", workspaceName: "Alpha", sessionId: "s-1" },
          { correlationId: "q-2", kind: "question", workspaceId: "ws-2", workspaceName: "Beta", sessionId: "s-2" },
        ],
      },
    });
    const entries = wrapper.findAll("[data-testid='attention-entry']");
    expect(entries).toHaveLength(2);
    expect(entries[0].text()).toContain("Alpha");
    await entries[1].trigger("click");
    expect(wrapper.emitted("navigate")?.[0]).toEqual([
      { workspaceId: "ws-2", sessionId: "s-2", interactionId: "q-2" },
    ]);
    wrapper.unmount();
  });
});
