// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import WorkstationShell from "../../src/shell/WorkstationShell.vue";

const BLOCKING_STATES = [
  "loading",
  "starting",
  "upgrading",
  "recovering",
  "stopping",
  "crashed",
  "unavailable",
  "incompatible",
] as const;

function mountShell(props: Record<string, unknown> = {}) {
  return mount(WorkstationShell, {
    attachTo: document.body,
    props: { runtimeState: "ready", mutationsAvailable: true, ...props },
    slots: {
      nav: "<nav data-testid='nav-content'>sessions</nav>",
      default: "<div data-testid='timeline-content'>timeline</div>",
      inspector: "<aside data-testid='inspector-content'>details</aside>",
      composer: "<form data-testid='composer-content'>composer</form>",
      interaction: "<div data-testid='interaction-content'>approval</div>",
    },
  });
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

describe("WorkstationShell runtime states", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    setViewportWidth(1280);
  });

  for (const state of BLOCKING_STATES) {
    it(`shows the compatibility surface without mutation controls in ${state}`, () => {
      const wrapper = mountShell({ runtimeState: state });
      expect(wrapper.find("[data-testid='compat-surface']").exists()).toBe(true);
      expect(wrapper.find("[data-testid='composer-content']").exists()).toBe(false);
      expect(wrapper.find("[data-testid='nav-content']").exists()).toBe(false);
      expect(wrapper.find("[data-testid='composer-region']").exists()).toBe(false);
      wrapper.unmount();
    });
  }

  it("renders the three-pane workstation when ready", () => {
    const wrapper = mountShell();
    expect(wrapper.find("[data-testid='nav-pane']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='center-pane']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='inspector-pane']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='composer-region']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='compat-surface']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps the composer reachable while busy", () => {
    const wrapper = mountShell({ runtimeState: "busy" });
    expect(wrapper.find("[data-testid='composer-region']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("marks the read-only partial state", () => {
    const wrapper = mountShell({ mutationsAvailable: false });
    expect(wrapper.find("[data-testid='readonly-badge']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("surfaces formalReleaseBlocked as a badge, never as a success", () => {
    const wrapper = mountShell({ formalReleaseBlocked: true });
    const badge = wrapper.find("[data-testid='release-blocked-badge']");
    expect(badge.exists()).toBe(true);
    expect(badge.attributes("data-tone")).not.toBe("success");
    wrapper.unmount();
  });

  it("shows an active interaction in the interaction region", () => {
    const wrapper = mountShell({ interactionActive: true });
    expect(wrapper.find("[data-testid='interaction-region']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='interaction-content']").exists()).toBe(true);
    wrapper.unmount();
  });
});

describe("WorkstationShell responsive panes", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    setViewportWidth(1280);
  });

  it("collapses left and right panes independently while keeping center mounted", async () => {
    const wrapper = mountShell();
    await wrapper.find("[data-testid='toggle-left']").trigger("click");
    expect(wrapper.find("[data-testid='nav-pane']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='inspector-pane']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='timeline-content']").exists()).toBe(true);

    await wrapper.find("[data-testid='toggle-right']").trigger("click");
    expect(wrapper.find("[data-testid='inspector-pane']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='timeline-content']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("switches to a control rail with overlay drawers in narrow viewports", async () => {
    const wrapper = mountShell();
    setViewportWidth(520);
    await nextTick();

    expect(wrapper.find("[data-testid='nav-rail']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='nav-pane']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='composer-region']").exists()).toBe(true);

    await wrapper.find("[data-testid='rail-nav']").trigger("click");
    expect(wrapper.find("[data-testid='overlay-nav']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='overlay-nav']").attributes("role")).toBe("dialog");
    expect(wrapper.find("[data-testid='nav-content']").exists()).toBe(true);

    await wrapper.find("[data-testid='overlay-close']").trigger("click");
    expect(wrapper.find("[data-testid='overlay-nav']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("restores focus to the rail trigger after the overlay closes", async () => {
    const wrapper = mountShell();
    setViewportWidth(520);
    await nextTick();

    const trigger = wrapper.find("[data-testid='rail-nav']");
    await trigger.trigger("click");
    expect(wrapper.find("[data-testid='overlay-nav']").exists()).toBe(true);

    await wrapper.find("[data-testid='overlay-close']").trigger("click");
    expect(document.activeElement).toBe(trigger.element);
    wrapper.unmount();
  });

  it("resizes the inspector within bounds", async () => {
    const wrapper = mountShell();
    const resizer = wrapper.find("[data-testid='inspector-resizer']");
    expect(resizer.exists()).toBe(true);
    await resizer.trigger("mousedown", { clientX: 1000 });
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 800 }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    const pane = wrapper.find("[data-testid='inspector-pane']");
    expect(Number.parseInt((pane.element as HTMLElement).style.width)).toBeGreaterThanOrEqual(240);
    wrapper.unmount();
  });
});
