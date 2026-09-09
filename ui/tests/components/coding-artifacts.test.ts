// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import DiffReviewPanel from "../../src/inspector/panels/DiffReviewPanel.vue";
import FilesPanel from "../../src/inspector/panels/FilesPanel.vue";
import TerminalPanel from "../../src/inspector/panels/TerminalPanel.vue";
import SubagentPanel from "../../src/inspector/panels/SubagentPanel.vue";
import StatisticsPanel from "../../src/inspector/panels/StatisticsPanel.vue";

describe("DiffReviewPanel", () => {
  it("preserves working-tree states and source revisions", () => {
    const wrapper = mount(DiffReviewPanel, {
      props: {
        snapshot: {
          diffId: "diff-1",
          path: "src/auth.ts",
          state: "staged",
          revision: "rev-7",
          hunks: [{ header: "@@ -1,3 +1,4 @@", lines: ["-old", "+new"] }],
        },
      },
    });
    expect(wrapper.find("[data-testid='diff-state']").text()).toBe("staged");
    expect(wrapper.find("[data-testid='diff-revision']").text()).toContain("rev-7");
    expect(wrapper.text()).toContain("src/auth.ts");
    // Read-only: no apply/revert controls are rendered.
    expect(wrapper.find("[data-testid='diff-apply']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='diff-revert']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps an older snapshot stable and requires an explicit move to newer data", async () => {
    const wrapper = mount(DiffReviewPanel, {
      props: {
        snapshot: { diffId: "diff-1", path: "a.ts", state: "proposed", revision: "rev-1", hunks: [] },
      },
    });
    await wrapper.setProps({ newerRevision: "rev-2" });
    expect(wrapper.find("[data-testid='diff-revision']").text()).toContain("rev-1");
    expect(wrapper.find("[data-testid='diff-newer-available']").exists()).toBe(true);
    await wrapper.find("[data-testid='diff-move-newer']").trigger("click");
    expect(wrapper.emitted("move-to-revision")?.[0]).toEqual(["rev-2"]);
    wrapper.unmount();
  });

  it("reports limitations without fabricating textual diff content", () => {
    const wrapper = mount(DiffReviewPanel, {
      props: {
        snapshot: {
          diffId: "diff-2",
          path: "logo.png",
          state: "unstaged",
          revision: "rev-3",
          limitation: { code: "BINARY_CONTENT", message: "binary file" },
        },
      },
    });
    expect(wrapper.find("[data-testid='diff-limitation']").text()).toContain("binary file");
    expect(wrapper.find("[data-testid='diff-content']").exists()).toBe(false);
    wrapper.unmount();
  });
});

describe("FilesPanel", () => {
  it("shows bounded preview with provenance, copy and advertised editor action only", () => {
    const wrapper = mount(FilesPanel, {
      props: {
        file: {
          path: "src/main.ts",
          revision: "rev-2",
          content: "const a = 1;",
          truncated: false,
          editorAvailable: true,
        },
      },
    });
    expect(wrapper.find("[data-testid='file-path']").text()).toContain("src/main.ts");
    expect(wrapper.find("[data-testid='file-revision']").text()).toContain("rev-2");
    expect(wrapper.find("[data-testid='file-copy']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='file-open-editor']").exists()).toBe(true);
    // No native file picker for session artifacts.
    expect(wrapper.find("input[type='file']").exists()).toBe(false);
    wrapper.unmount();

    const noEditor = mount(FilesPanel, {
      props: { file: { path: "b.ts", content: "x", truncated: false, editorAvailable: false } },
    });
    expect(noEditor.find("[data-testid='file-open-editor']").exists()).toBe(false);
    noEditor.unmount();
  });

  it("masks Host-identified sensitive ranges before display and copy", () => {
    const wrapper = mount(FilesPanel, {
      props: {
        file: {
          path: ".env.ts",
          content: 'const token = "sk-live-SECRET"; const ok = 1;',
          truncated: false,
          sensitiveRanges: [{ start: 15, end: 30 }],
          editorAvailable: false,
        },
      },
    });
    const preview = wrapper.find("[data-testid='file-preview']").text();
    expect(preview).not.toContain("sk-live-SECRET");
    expect(wrapper.find("[data-testid='file-sensitive-warning']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("requires an explicit bounded load for large content", () => {
    const wrapper = mount(FilesPanel, {
      props: {
        file: { path: "big.log", content: undefined, truncated: true, byteLength: 5_000_000, editorAvailable: false },
      },
    });
    expect(wrapper.find("[data-testid='file-load-more']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='file-preview']").text()).not.toContain("undefined");
    wrapper.unmount();
  });
});

describe("TerminalPanel", () => {
  it("releases renderer resources on unmount without terminating Host work", async () => {
    const wrapper = mount(TerminalPanel, {
      props: { terminal: { terminalId: "term-1", capabilities: ["terminal.send"] } },
    });
    expect(wrapper.find("[data-testid='terminal-send']").exists()).toBe(true);
    wrapper.unmount();
    // Unmounting must not emit terminate; only the explicit action does.
    expect(wrapper.emitted("terminate")).toBeUndefined();
  });

  it("hides interactive controls without the capability and terminates only explicitly", async () => {
    const wrapper = mount(TerminalPanel, {
      props: { terminal: { terminalId: "term-2", capabilities: [], terminateAvailable: true } },
    });
    expect(wrapper.find("[data-testid='terminal-send']").exists()).toBe(false);
    await wrapper.find("[data-testid='terminal-terminate']").trigger("click");
    expect(wrapper.emitted("terminate")?.[0]).toEqual(["term-2"]);
    wrapper.unmount();
  });
});

describe("SubagentPanel", () => {
  it("preserves lineage, order and source and omits unsupported controls", () => {
    const wrapper = mount(SubagentPanel, {
      props: {
        subagent: {
          agentId: "agent-1",
          name: "explorer",
          parentSessionId: "session-1",
          spawnOrder: 2,
          source: "dsh",
          status: "running",
          controls: [],
        },
      },
    });
    expect(wrapper.find("[data-testid='subagent-lineage']").text()).toContain("session-1");
    expect(wrapper.find("[data-testid='subagent-order']").text()).toContain("2");
    expect(wrapper.find("[data-testid='subagent-source']").text()).toContain("dsh");
    expect(wrapper.find("[data-testid='subagent-control']").exists()).toBe(false);
    wrapper.unmount();
  });
});

describe("StatisticsPanel", () => {
  it("renders exact facts when authoritative and never estimates", () => {
    const wrapper = mount(StatisticsPanel, {
      props: {
        statistics: {
          authoritative: true,
          tokens: { input: 1200, output: 340 },
          cacheHits: 7,
          turns: 3,
        },
      },
    });
    expect(wrapper.find("[data-testid='stat-tokens-input']").text()).toBe("1200");
    expect(wrapper.find("[data-testid='stat-turns']").text()).toBe("3");
    wrapper.unmount();
  });

  it("reports unavailable without the capability instead of estimating", () => {
    const wrapper = mount(StatisticsPanel, { props: { statistics: { authoritative: false } } });
    expect(wrapper.find("[data-testid='stat-unavailable']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='stat-tokens-input']").exists()).toBe(false);
    wrapper.unmount();
  });
});
