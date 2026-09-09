// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import PresetSelector from "../../src/presets/PresetSelector.vue";
import CreativeModeDialog from "../../src/creative/CreativeModeDialog.vue";

const ROSTER = [
  { id: "minimal", label: "Minimal", available: true },
  { id: "standard", label: "Standard", available: true },
  { id: "ptc", label: "PTC", available: true },
  { id: "creative", label: "Creative", available: true, creative: true },
  { id: "future-x", label: "Future X (runtime label)", available: true },
];

describe("PresetSelector", () => {
  it("renders every compatible entry through the same generic roster path", () => {
    const wrapper = mount(PresetSelector, { props: { roster: ROSTER, activePresetId: "standard" } });
    const entries = wrapper.findAll("[data-testid='preset-entry']");
    expect(entries).toHaveLength(5);
    const labels = entries.map((entry) => entry.find("[data-testid='preset-label']").text());
    expect(labels).toEqual(["Minimal", "Standard", "PTC", "Creative", "Future X (runtime label)"]);
    // The unknown future preset is selectable through the identical flow.
    const future = entries[4].find("[data-testid='preset-select']");
    expect((future.element as HTMLButtonElement).disabled).toBe(false);
    wrapper.unmount();
  });

  it("keeps historical labels unchanged when the active preset changes", () => {
    const first = mount(PresetSelector, { props: { roster: ROSTER, activePresetId: "minimal" } });
    const before = first.findAll("[data-testid='preset-label']").map((entry) => entry.text());
    first.unmount();
    const second = mount(PresetSelector, { props: { roster: ROSTER, activePresetId: "creative" } });
    const after = second.findAll("[data-testid='preset-label']").map((entry) => entry.text());
    second.unmount();
    expect(after).toEqual(before);
  });

  it("shows Host reasons for deferred switches without offering forced restart", async () => {
    const wrapper = mount(PresetSelector, {
      props: {
        roster: [
          { id: "standard", label: "Standard", available: true },
          {
            id: "creative",
            label: "Creative",
            available: false,
            reason: "deferred until the active Turn finishes",
          },
        ],
        activePresetId: "standard",
      },
    });
    const entries = wrapper.findAll("[data-testid='preset-entry']");
    const creative = entries[1];
    expect((creative.find("[data-testid='preset-select']").element as HTMLButtonElement).disabled).toBe(true);
    expect(creative.find("[data-testid='preset-reason']").text()).toContain("deferred until the active Turn finishes");
    expect(wrapper.find("[data-testid='preset-force-restart']").exists()).toBe(false);
    // Available entries still select normally.
    await entries[0].find("[data-testid='preset-select']").trigger("click");
    expect(wrapper.emitted("select")).toBeUndefined(); // already active
    wrapper.unmount();
  });

  it("emits one selection for a compatible non-active preset", async () => {
    const wrapper = mount(PresetSelector, { props: { roster: ROSTER, activePresetId: "standard" } });
    await wrapper.findAll("[data-testid='preset-select']")[0].trigger("click");
    expect(wrapper.emitted("select")?.[0]).toEqual(["minimal"]);
    wrapper.unmount();
  });
});

describe("CreativeModeDialog", () => {
  it("requires per-session risk confirmation before one Host request", async () => {
    const wrapper = mount(CreativeModeDialog, {
      props: { open: true, sessionId: "session-1", eligible: true },
    });
    expect(wrapper.find("[data-testid='creative-risk-text']").text()).toContain("self-modification");
    expect(wrapper.find("[data-testid='creative-risk-text']").text()).toContain("dynamic");
    const confirm = wrapper.find("[data-testid='creative-confirm']");
    expect((confirm.element as HTMLButtonElement).disabled).toBe(true);
    await wrapper.find("[data-testid='creative-acknowledge']").setValue(true);
    await confirm.trigger("click");
    expect(wrapper.emitted("enter-creative")).toHaveLength(1);
    expect(wrapper.emitted("enter-creative")?.[0]).toEqual([{ sessionId: "session-1" }]);
    await confirm.trigger("click");
    expect(wrapper.emitted("enter-creative")).toHaveLength(1);
    wrapper.unmount();
  });

  it("never inherits consent and states the Host default for new sessions", () => {
    const wrapper = mount(CreativeModeDialog, {
      props: {
        open: true,
        sessionId: "session-2",
        eligible: true,
        otherSessionCreative: true,
        hostDefaultPresetId: "standard",
      },
    });
    expect(wrapper.find("[data-testid='creative-no-inheritance']").text()).toContain("standard");
    expect((wrapper.find("[data-testid='creative-confirm']").element as HTMLButtonElement).disabled).toBe(true);
    wrapper.unmount();
  });

  it("renders the Host-reported isolated-generation transition", () => {
    const wrapper = mount(CreativeModeDialog, {
      props: {
        open: true,
        sessionId: "session-1",
        eligible: true,
        transition: { fromGeneration: "gen-1", toGeneration: "gen-2", isolated: true },
      },
    });
    const transition = wrapper.find("[data-testid='creative-transition']");
    expect(transition.text()).toContain("gen-1");
    expect(transition.text()).toContain("gen-2");
    expect(transition.text()).toContain("isolated");
    wrapper.unmount();
  });

  it("shows the Host reason when the transition is blocked and preserves other sessions", () => {
    const wrapper = mount(CreativeModeDialog, {
      props: {
        open: true,
        sessionId: "session-1",
        eligible: false,
        blockedReason: "lease transfer pending",
      },
    });
    expect(wrapper.find("[data-testid='creative-blocked']").text()).toContain("lease transfer pending");
    expect(wrapper.find("[data-testid='creative-other-sessions-note']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='creative-confirm']").exists()).toBe(false);
    wrapper.unmount();
  });
});
