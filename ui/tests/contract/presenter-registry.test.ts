import { describe, expect, it } from "vitest";
import {
  resolvePresenter,
  toViewModelSafe,
  GENERIC_PRESENTER_ID,
  PRESENTER_VIEW_MODEL_BOUND,
} from "../../src/presenters/registry";
import type { ProjectedEvent } from "../../src/state/reducers/session-reducer";

const KNOWN_KINDS: readonly [kind: string, family: string][] = [
  ["user/message", "message"],
  ["assistant/message", "message"],
  ["reasoning/delta", "reasoning"],
  ["tool/call", "tool"],
  ["job/started", "job"],
  ["workflow/step", "workflow"],
  ["context/summary", "context"],
  ["file/written", "file"],
  ["diff/created", "diff"],
  ["terminal/output", "terminal"],
  ["subagent/spawned", "subagent"],
];

function event(kind: string, data: unknown): ProjectedEvent {
  return { kind, turnId: "turn-1", sessionId: "session-1", data };
}

describe("presenter registry", () => {
  it("resolves every known family and renders semantic summaries without transport internals", () => {
    for (const [kind, family] of KNOWN_KINDS) {
      const presenter = resolvePresenter(kind);
      expect(presenter.id, kind).toBe(family);
    }

    const message = toViewModelSafe(
      event("assistant/message", {
        content: [{ type: "text", text: "Refactor complete" }],
        model: "deepseek-chat",
        source: "deepseek",
        preset: "coding-default",
      }),
    );
    expect(message.summary).toContain("Refactor complete");
    expect(message.provenance).toMatchObject({ model: "deepseek-chat", source: "deepseek", preset: "coding-default" });
    const serialized = JSON.stringify(message);
    expect(serialized).not.toContain("domainGenerationId");
    expect(serialized).not.toContain("contractHash");

    const tool = toViewModelSafe(
      event("tool/call", { name: "shell", status: "running", input: { command: "bun test" } }),
    );
    expect(tool.summary).toContain("shell");
    expect(tool.status).toBe("running");
  });

  it("falls back to safe provenance when Host fields are absent", () => {
    const message = toViewModelSafe(event("assistant/message", { content: [{ type: "text", text: "hi" }] }));
    expect(message.provenance).toBeDefined();
    expect(typeof message.provenance?.model).toBe("string");
  });

  it("masks and bounds an unknown oversized credential-like payload", () => {
    const huge = {
      apiKey: "sk-live-SUPERSECRET",
      authorization: "Bearer tok-123",
      password: "p@ssw0rd!",
      note: "x".repeat(20_000),
      nested: { token: "abc123", deep: { secretKey: "xyz" } },
    };
    const generic = resolvePresenter("telemetry/custom-additive");
    expect(generic.id).toBe(GENERIC_PRESENTER_ID);
    const view = toViewModelSafe(event("telemetry/custom-additive", huge));
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("sk-live-SUPERSECRET");
    expect(serialized).not.toContain("tok-123");
    expect(serialized).not.toContain("p@ssw0rd!");
    expect(serialized).not.toContain("abc123");
    expect(serialized.length).toBeLessThanOrEqual(PRESENTER_VIEW_MODEL_BOUND);
    // A raw-detail path stays available without dumping content inline.
    expect(view.actions?.some((action) => action.id === "more-details")).toBe(true);
  });

  it("isolates presenter failures on malformed DTOs instead of throwing", () => {
    const view = toViewModelSafe(event("tool/call", "not-an-object"));
    expect(view.summary.length).toBeGreaterThan(0);
    expect(view.degraded).toBe(true);
  });
});
