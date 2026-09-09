// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import NavigationPane from "../../src/navigation/NavigationPane.vue";
import WorkspaceHeader from "../../src/navigation/WorkspaceHeader.vue";
import { useSessionSearch } from "../../src/navigation/use-session-search";
import { createSessionStore, type SessionSummary } from "../../src/state/session-store";

const GROUP_ORDER = [
  "need-attention",
  "running",
  "current-workspace",
  "recently-visited",
  "workspace-management",
  "archived",
] as const;

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    workspaces: [
      { id: "ws-1", name: "Alpha" },
      { id: "ws-2", name: "Beta" },
    ],
    currentWorkspaceId: "ws-1",
    sessions: [
      { id: "session-1", title: "Refactor auth", workspaceId: "ws-1" },
      { id: "session-2", title: "Beta migration", workspaceId: "ws-2" },
      { id: "session-3", title: "Old notes", workspaceId: "ws-1", archived: true },
    ] as SessionSummary[],
    attention: [{ sessionId: "session-1", kind: "approval" as const }],
    running: ["session-1"],
    recent: ["session-1", "session-2"],
    collapsedSections: {} as Record<string, boolean>,
    ...overrides,
  };
}

describe("NavigationPane projections", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the fixed group order and keeps one Host identity across projections", () => {
    const wrapper = mount(NavigationPane, { props: baseProps() });
    const sections = wrapper
      .findAll("[data-testid='nav-section']")
      .map((section) => section.attributes("data-section"));
    expect(sections).toEqual([...GROUP_ORDER]);

    // session-1 is running, needs attention and recently visited: every row
    // must carry the same Host session identity, never a per-projection copy.
    const rows = wrapper.findAll("[data-session-id='session-1']");
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row.attributes("data-session-id")).toBe("session-1");
    }
    wrapper.unmount();
  });

  it("shows non-color status text and workspace/source/model labels on rows", () => {
    const wrapper = mount(
      NavigationPane,
      {
        props: baseProps({
          sessionLabels: {
            "session-1": { workspaceName: "Alpha", source: "dsh", model: "deepseek-chat" },
          },
        }),
      },
    );
    const row = wrapper.find("[data-session-id='session-1']");
    expect(row.text()).toContain("Running");
    expect(row.text()).toContain("Needs attention");
    expect(row.text()).toContain("Alpha");
    expect(row.text()).toContain("deepseek-chat");
    const status = row.find("[data-testid='row-status']");
    expect(status.attributes("aria-label")).toContain("Running");
    wrapper.unmount();
  });

  it("collapses a section manually and keeps the center content decision local", async () => {
    const wrapper = mount(NavigationPane, { props: baseProps() });
    const toggle = wrapper.find("[data-testid='section-toggle-running']");
    await toggle.trigger("click");
    expect(wrapper.emitted("toggle-section")?.[0]).toEqual(["running"]);

    const collapsed = mount(NavigationPane, {
      props: baseProps({ collapsedSections: { running: true } }),
    });
    expect(collapsed.find("[data-testid='section-toggle-running']").attributes("aria-expanded")).toBe("false");
    expect(collapsed.find("[data-section='running'] [data-session-id]").exists()).toBe(false);
    // Other sections stay visible while one is folded.
    expect(collapsed.find("[data-section='need-attention'] [data-session-id]").exists()).toBe(true);
    wrapper.unmount();
    collapsed.unmount();
  });

  it("opens a cross-workspace session by switching context without cancelling others", async () => {
    const wrapper = mount(NavigationPane, { props: baseProps() });
    const betaRow = wrapper.find("[data-section='recently-visited'] [data-session-id='session-2']");
    await betaRow.trigger("click");
    const openEvents = wrapper.emitted("open-session") ?? [];
    expect(openEvents[0]).toEqual([{ sessionId: "session-2", workspaceId: "ws-2" }]);
    expect(wrapper.emitted("switch-workspace")?.[0]).toEqual(["ws-2"]);
    // Background sessions keep running: navigation never emits cancellation.
    expect(wrapper.emitted("cancel-session")).toBeUndefined();
    wrapper.unmount();
  });
});

describe("WorkspaceHeader", () => {
  it("offers workspace switching, global search and new-session creation", async () => {
    const wrapper = mount(WorkspaceHeader, {
      props: {
        workspaces: [
          { id: "ws-1", name: "Alpha" },
          { id: "ws-2", name: "Beta" },
        ],
        currentWorkspaceId: "ws-1",
        createAvailability: { enabled: true },
        searchAvailability: { enabled: true },
      },
    });
    await wrapper.find("[data-testid='workspace-switch']").setValue("ws-2");
    expect(wrapper.emitted("switch-workspace")?.[0]).toEqual(["ws-2"]);

    const search = wrapper.find("[data-testid='session-search']");
    await search.setValue("auth");
    await search.trigger("submit");
    expect(wrapper.emitted("search")?.[0]).toEqual(["auth"]);

    await wrapper.find("[data-testid='new-session']").trigger("click");
    expect(wrapper.emitted("create-session")).toBeTruthy();
    wrapper.unmount();
  });

  it("disables creation with a reason when the Host did not negotiate it", () => {
    const wrapper = mount(WorkspaceHeader, {
      props: {
        workspaces: [{ id: "ws-1", name: "Alpha" }],
        currentWorkspaceId: "ws-1",
        createAvailability: {
          enabled: false,
          reason: { code: "CAPABILITY_UNAVAILABLE" },
        },
        searchAvailability: { enabled: true },
      },
    });
    const button = wrapper.find("[data-testid='new-session']");
    expect((button.element as HTMLButtonElement).disabled).toBe(true);
    expect(button.attributes("aria-disabled")).toBe("true");
    expect(button.attributes("title") ?? "").toContain("CAPABILITY_UNAVAILABLE");
    wrapper.unmount();
  });
});

describe("useSessionSearch", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("keeps only the latest generation and aborts the obsolete query", async () => {
    const store = createSessionStore();
    const first = deferred<SessionSummary[]>();
    const second = deferred<SessionSummary[]>();
    const aborted: string[] = [];
    const queries: string[] = [];
    let call = 0;

    const search = useSessionSearch({
      store,
      runQuery(query: string, signal: AbortSignal) {
        queries.push(query);
        signal.addEventListener("abort", () => aborted.push(query));
        call += 1;
        return call === 1 ? first.promise : second.promise;
      },
    });

    const older = search.submit("old");
    const newer = search.submit("new");
    second.resolve([{ id: "session-9", title: "new hit" }]);
    await newer;
    first.resolve([{ id: "session-8", title: "old hit" }]);
    await older;
    await nextTick();

    expect(queries).toEqual(["old", "new"]);
    expect(aborted).toContain("old");
    expect(store.state.search?.query).toBe("new");
    expect(store.state.search?.results).toEqual([{ id: "session-9", title: "new hit" }]);
  });

  it("records a failed search without leaving stale results", async () => {
    const store = createSessionStore();
    const search = useSessionSearch({
      store,
      runQuery() {
        return Promise.reject(new Error("host-operation-failed"));
      },
    });
    const outcome = await search.submit("boom");
    expect(outcome.ok).toBe(false);
    expect(store.state.search?.results).toEqual([]);
  });
});
