// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import DynamicExtensionCard from "../../src/creative/DynamicExtensionCard.vue";
import DynamicExtensionsPanel from "../../src/creative/DynamicExtensionsPanel.vue";

describe("Host-half dynamic packages", () => {
  it("renders identity, generation, status, source and only Host-advertised actions", () => {
    const wrapper = mount(DynamicExtensionCard, {
      props: {
        extension: {
          packageId: "pkg-1",
          generation: "gen-3",
          status: "running",
          source: "dsh-host",
          actions: ["stop", "diagnostics"],
        },
      },
    });
    expect(wrapper.find("[data-testid='ext-id']").text()).toContain("pkg-1");
    expect(wrapper.find("[data-testid='ext-generation']").text()).toContain("gen-3");
    expect(wrapper.find("[data-testid='ext-status']").text()).toBe("running");
    expect(wrapper.find("[data-testid='ext-source']").text()).toContain("dsh-host");
    const actions = wrapper.findAll("[data-testid='ext-action']");
    expect(actions.map((action) => action.attributes("data-action"))).toEqual(["stop", "diagnostics"]);
    wrapper.unmount();
  });

  it("shows retired generations inactive without any automatic replay control", () => {
    const wrapper = mount(DynamicExtensionCard, {
      props: {
        extension: {
          packageId: "pkg-1",
          generation: "gen-2",
          status: "retired",
          source: "dsh-host",
          actions: [],
        },
      },
    });
    expect(wrapper.find("[data-testid='ext-inactive']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='ext-action']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='ext-replay']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='ext-recreate']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("dispatches a Host action exactly once per click", async () => {
    const wrapper = mount(DynamicExtensionCard, {
      props: {
        extension: { packageId: "pkg-2", generation: "gen-1", status: "running", source: "dsh-host", actions: ["stop"] },
      },
    });
    await wrapper.find("[data-testid='ext-action']").trigger("click");
    expect(wrapper.emitted("action")?.[0]).toEqual([{ packageId: "pkg-2", action: "stop" }]);
    wrapper.unmount();
  });
});

describe("browser-half boundary and generated source", () => {
  it("reports the unsupported boundary immediately without mounting or waiting", () => {
    const wrapper = mount(DynamicExtensionsPanel, {
      props: {
        extensions: [
          {
            packageId: "pkg-browser",
            generation: "gen-1",
            status: "running",
            source: "dsh-host",
            execution: "browser-half",
            actions: [],
          },
        ],
      },
    });
    const unsupported = wrapper.find("[data-testid='browser-half-unsupported']");
    expect(unsupported.exists()).toBe(true);
    expect(unsupported.text()).toContain("unsupported");
    // Nothing is mounted for the browser-half package and no bridge wait happens.
    expect(wrapper.find("[data-testid='ext-id']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='browser-half-waiting']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("treats generated source strictly as an artifact", () => {
    const wrapper = mount(DynamicExtensionsPanel, {
      props: {
        extensions: [
          {
            packageId: "pkg-gen",
            generation: "gen-1",
            status: "defined",
            source: "dsh-host",
            generatedSourcePath: "staging/pkg-gen.tar.gz",
            actions: [],
          },
        ],
      },
    });
    expect(wrapper.find("[data-testid='ext-artifact']").text()).toContain("staging/pkg-gen.tar.gz");
    expect(wrapper.find("[data-testid='ext-install']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='ext-activate']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='ext-manage-ecosystem']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders AIO-origin-like tool identity as diagnostic context only", () => {
    const wrapper = mount(DynamicExtensionsPanel, {
      props: {
        extensions: [
          {
            packageId: "pkg-bridge",
            generation: "gen-1",
            status: "running",
            source: "dsh-host",
            reportedToolIdentity: "aio:media-generator",
            actions: [],
          },
        ],
      },
    });
    expect(wrapper.find("[data-testid='ext-tool-identity']").text()).toContain("aio:media-generator");
    expect(wrapper.find("[data-testid='ext-dispatch-tool']").exists()).toBe(false);
    wrapper.unmount();
  });
});
