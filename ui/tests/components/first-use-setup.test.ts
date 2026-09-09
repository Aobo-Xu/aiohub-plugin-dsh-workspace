// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import FirstUseSetup from "../../src/shell/FirstUseSetup.vue";
import { resetSdkStubs, stubProfiles, configWrites } from "../stubs/aiohub-sdk";

const WORKSPACES = [
  { id: "ws-1", name: "aio-hub", path: "E:/workspace/projects/aio-hub" },
  { id: "ws-2", name: "notes", path: "E:/notes" },
];

const PRESETS = [
  { id: "code", label: "Code", description: "default coding agent" },
  { id: "plan", label: "Plan" },
];

const PERMISSIONS = [
  { id: "workspace-write", label: "Workspace write", recommended: true },
  { id: "network", label: "Network access" },
];

function mountSetup(props: Record<string, unknown> = {}) {
  return mount(FirstUseSetup, {
    attachTo: document.body,
    props: {
      workspaceOptions: WORKSPACES,
      presets: PRESETS,
      permissionChoices: PERMISSIONS,
      ...props,
    },
  });
}

describe("FirstUseSetup", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    resetSdkStubs();
  });

  it("renders only the provided workspaces, presets and permission choices", () => {
    const wrapper = mountSetup();
    const options = wrapper.findAll("[data-testid='workspace-option']");
    expect(options).toHaveLength(2);
    expect(wrapper.findAll("[data-testid='preset-option']")).toHaveLength(2);
    expect(wrapper.findAll("[data-testid='permission-option']")).toHaveLength(2);
    wrapper.unmount();
  });

  it("keeps complete disabled until workspace, model and preset are chosen", async () => {
    stubProfiles.value = [{ id: "profile-1" }];
    const wrapper = mountSetup();
    const complete = wrapper.find("[data-testid='setup-complete']");
    expect(complete.attributes("disabled")).toBeDefined();

    await wrapper.find("[data-testid='workspace-select']").setValue("ws-1");
    await wrapper.find("[data-testid='preset-code']").setValue();
    expect(complete.attributes("disabled")).toBeDefined();

    await wrapper.find("[data-testid='llm-model-selector']").trigger("click");
    expect(complete.attributes("disabled")).toBeUndefined();

    await complete.trigger("click");
    const payload = wrapper.emitted("complete");
    expect(payload).toHaveLength(1);
    expect(payload?.[0]?.[0]).toMatchObject({
      workspaceId: "ws-1",
      model: "profile-1:model-1",
      presetId: "code",
    });
    wrapper.unmount();
  });

  it("routes missing AIO model configuration to AIO settings instead of duplicating it", () => {
    stubProfiles.value = [];
    const wrapper = mountSetup();
    expect(wrapper.find("[data-testid='model-missing-hint']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='llm-model-selector']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("surfaces Host-provided limits without local amplification", () => {
    const wrapper = mountSetup({ hostLimits: { maxAttachments: 4 } });
    expect(wrapper.find("[data-testid='host-limits']").text()).toContain("4");
    wrapper.unmount();
  });

  it("emits browse-workspace instead of implementing its own file dialog", async () => {
    const wrapper = mountSetup();
    await wrapper.find("[data-testid='workspace-browse']").trigger("click");
    expect(wrapper.emitted("browse-workspace")).toHaveLength(1);
    wrapper.unmount();
  });

  it("persists nothing into plugin configuration", async () => {
    stubProfiles.value = [{ id: "profile-1" }];
    const wrapper = mountSetup();
    await wrapper.find("[data-testid='workspace-select']").setValue("ws-2");
    await wrapper.find("[data-testid='preset-plan']").setValue();
    await wrapper.find("[data-testid='llm-model-selector']").trigger("click");
    await wrapper.find("[data-testid='setup-complete']").trigger("click");
    expect(configWrites).toHaveLength(0);
    wrapper.unmount();
  });
});
