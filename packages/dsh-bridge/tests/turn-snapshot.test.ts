import { describe, expect, it } from "vitest";
import { createTurnSnapshot } from "../src/turn-snapshot.js";
import type { TurnConfigSnapshot } from "../../packages/runtime-facade/src/types.js";

const base: TurnConfigSnapshot = {
  snapshotVersion: 1,
  routeId: "route-1",
  model: "deepseek-chat",
  parameters: { temperature: 0.2 },
  promptContribution: "Use {{Nova}} literally.",
  workspace: "E:/workspace",
  permission: "workspace-write",
  sandboxPolicy: "ask",
};

describe("turn snapshot", () => {
  it("returns the same immutable snapshot across retry, tool, and compaction", () => {
    const store = createTurnSnapshot();
    const snapshot = store.begin(base);

    expect(store.forRetry(snapshot.id)).toBe(snapshot);
    expect(store.forTool(snapshot.id)).toBe(snapshot);
    expect(store.forCompaction(snapshot.id)).toBe(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("returns the same snapshot for get and all step variants", () => {
    const store = createTurnSnapshot();
    const snapshot = store.begin(base);

    expect(store.get(snapshot.id)).toBe(snapshot);
    expect(store.forRetry(snapshot.id)).toBe(store.get(snapshot.id));
    expect(store.forTool(snapshot.id)).toBe(store.get(snapshot.id));
    expect(store.forCompaction(snapshot.id)).toBe(store.get(snapshot.id));
  });

  it("does not allow later AIO edits to change an active turn snapshot", () => {
    const store = createTurnSnapshot();
    const snapshot = store.begin(base);
    const mutableAttempt = snapshot as unknown as { model: string };

    expect(() => {
      mutableAttempt.model = "changed-model";
    }).toThrow();
    expect(snapshot.model).toBe("deepseek-chat");
  });

  it("keeps nested parameters immutable", () => {
    const store = createTurnSnapshot();
    const snapshot = store.begin(base);
    const parameters = snapshot.parameters as { temperature: number };

    expect(() => {
      parameters.temperature = 1;
    }).toThrow();
    expect(snapshot.parameters).toEqual({ temperature: 0.2 });
  });

  it("starts a new snapshot for the next turn without affecting the previous one", () => {
    const store = createTurnSnapshot();
    const first = store.begin(base);
    const second = store.begin({ ...base, model: "next-model" });

    expect(first.model).toBe("deepseek-chat");
    expect(second.model).toBe("next-model");
    expect(store.get(first.id)).toBe(first);
    expect(store.get(second.id)).toBe(second);
  });
});

