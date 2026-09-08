import { describe, expect, it } from "vitest";
import { normalizeExecutionProjection } from "../src/presenters/execution-projection.js";

describe("DSH-owned execution projection", () => {
  it("preserves job/workflow/subagent identity and only advertises supplied controls", () => {
    const result = normalizeExecutionProjection({
      kind: "subagent",
      id: "subagent-1",
      parentId: "job-1",
      sessionId: "session-1",
      generation: "generation-1",
      status: "running",
      progress: { completed: 2, total: 4 },
      operations: { "subagent.stop": true, "subagent.queue": false },
    });
    expect(result).toMatchObject({
      kind: "subagent",
      id: "subagent-1",
      parentId: "job-1",
      status: "running",
      progress: { completed: 2, total: 4 },
      actions: ["subagent.stop"],
    });
  });
});
