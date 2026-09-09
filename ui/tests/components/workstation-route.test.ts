// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import WorkstationRoute from "../../src/entry/WorkstationRoute.vue";

const FULL_CAPS = [
  "workspace.list",
  "workspace.open",
  "session.list",
  "session.open",
  "session.create",
  "session.history",
  "session.snapshot",
  "session.submit-prompt",
  "session.update-queue",
  "session.steer",
  "session.cancel",
  "interaction.approval",
  "attachment.limits",
];

function createFakeFacade(capabilities: readonly string[] = FULL_CAPS) {
  const state = {
    queries: [] as string[],
    acquireCalls: [] as { sessionId?: string }[],
    commands: [] as { kind: string }[],
    shutdowns: 0,
    subscriptions: 0,
  };
  const facade = {
    availability: (capabilityId: string) =>
      capabilities.includes(capabilityId) ? { available: true } : { available: false },
    capabilities: () => capabilities.map((capabilityId) => ({ capabilityId, schemaRevision: 1 })),
    acquireSession: async (input: { sessionId?: string }) => {
      state.acquireCalls.push(input);
      return {
        domainGenerationId: "gen-1",
        contractHash: "hash-1",
        sessionId: input.sessionId ?? "session-1",
        leaseId: "lease-1",
        mode: "controller" as const,
      };
    },
    command: async (_lease: unknown, command: { kind: string }) => {
      state.commands.push(command);
      return { accepted: true };
    },
    query: async (command: { kind: string }) => {
      state.queries.push(command.kind);
      if (command.kind === "workspace.list") {
        return { items: [{ id: "ws-1", name: "Alpha" }] };
      }
      if (command.kind === "session.list") {
        return { items: [{ id: "session-1", title: "First session", workspaceId: "ws-1" }] };
      }
      return {};
    },
    snapshot: async (sessionId: string) => ({
      domainGenerationId: "gen-1",
      contractHash: "hash-1",
      source: "dsh",
      provenance: { adapterId: "fake" },
      sessionId,
      cursor: "cursor-0",
      seq: 0,
      durableFacts: [],
    }),
    subscribe: () => {
      state.subscriptions += 1;
      return () => {};
    },
    shutdown: async (_reason?: string) => {
      state.shutdowns += 1;
    },
  };
  return { facade, state };
}

function fakeWorkstation(facade: ReturnType<typeof createFakeFacade>["facade"], overrides: Record<string, unknown> = {}) {
  return async () =>
    ({
      facade,
      runtime: { domainGenerationId: "gen-1", contractHash: "hash-1" },
      state: "ready",
      negotiated: facade.capabilities(),
      mutationsAvailable: true,
      shutdown: () => facade.shutdown("user-stop"),
      ...overrides,
    }) as never;
}

async function mountRoute(compose: () => Promise<unknown>) {
  const wrapper = mount(WorkstationRoute, { props: { compose: compose as never }, attachTo: document.body });
  await nextTick();
  await nextTick();
  await Promise.resolve();
  await nextTick();
  return wrapper;
}

describe("WorkstationRoute production composition", () => {
  it("fails closed without a compatible Host", async () => {
    const failure = Object.assign(new Error("plugin missing"), { code: "PLUGIN_NOT_ACTIVE" });
    const wrapper = await mountRoute(() => Promise.reject(failure));
    expect(wrapper.find("[data-testid='compat-surface']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='composer-form']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='nav-section']").exists()).toBe(false);
    expect(wrapper.text()).toContain("PLUGIN_NOT_ACTIVE");
    wrapper.unmount();
  });

  it("reports incompatible state on contract mismatch", async () => {
    const failure = Object.assign(new Error("hash drift"), { code: "CONTRACT_MISMATCH" });
    const wrapper = await mountRoute(() => Promise.reject(failure));
    expect(wrapper.find("[data-testid='compat-surface']").exists()).toBe(true);
    expect(wrapper.text().toLowerCase()).toContain("incompatible");
    wrapper.unmount();
  });

  it("loads catalogs, opens a session through the nav and enables the composer with a lease", async () => {
    const { facade, state } = createFakeFacade();
    const wrapper = await mountRoute(fakeWorkstation(facade));
    expect(state.subscriptions).toBe(1);
    expect(state.queries).toContain("workspace.list");
    expect(state.queries).toContain("session.list");
    expect(wrapper.find("[data-testid='nav-section']").exists()).toBe(true);

    // No session open yet: mutations stay fenced.
    const send = wrapper.find("[data-testid='composer-send']");
    expect((send.element as HTMLButtonElement).disabled).toBe(true);

    await wrapper.find("[data-session-id='session-1']").trigger("click");
    await nextTick();
    await Promise.resolve();
    await nextTick();
    expect(state.acquireCalls[0]).toMatchObject({ sessionId: "session-1" });
    const enabled = wrapper.find("[data-testid='composer-send']");
    expect((enabled.element as HTMLButtonElement).disabled).toBe(false);
    wrapper.unmount();
  });

  it("keeps mutations read-only when the Host dropped session mutations", async () => {
    const { facade } = createFakeFacade(["workspace.list", "session.list", "session.open", "session.history", "session.snapshot"]);
    const wrapper = await mountRoute(fakeWorkstation(facade, { mutationsAvailable: false }));
    await wrapper.find("[data-session-id='session-1']").trigger("click");
    await nextTick();
    await Promise.resolve();
    await nextTick();
    const send = wrapper.find("[data-testid='composer-send']");
    expect((send.element as HTMLButtonElement).disabled).toBe(true);
    expect(wrapper.find("[data-testid='composer-observer-note']").exists() || send.attributes("disabled") !== undefined).toBe(true);
    wrapper.unmount();
  });

  it("shuts the Host binding down on unmount", async () => {
    const { facade, state } = createFakeFacade();
    const wrapper = await mountRoute(fakeWorkstation(facade));
    wrapper.unmount();
    await Promise.resolve();
    expect(state.shutdowns).toBe(1);
  });
});
