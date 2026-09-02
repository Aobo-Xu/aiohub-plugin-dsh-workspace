import type { TurnConfigSnapshot } from "../../runtime-facade/src/types.js";

export type StoredTurnSnapshot = Readonly<TurnConfigSnapshot> & {
  id: string;
};

export interface TurnSnapshotStore {
  begin(input: TurnConfigSnapshot): StoredTurnSnapshot;
  forCompaction(id: string): StoredTurnSnapshot;
  forRetry(id: string): StoredTurnSnapshot;
  forTool(id: string): StoredTurnSnapshot;
  get(id: string): StoredTurnSnapshot;
}

export function createTurnSnapshot(): TurnSnapshotStore {
  const snapshots = new Map<string, StoredTurnSnapshot>();
  let counter = 0;

  return {
    begin(input) {
      validateSnapshot(input);
      counter += 1;
      const snapshot = deepFreeze({
        ...input,
        id: `turn-${counter}`,
      }) as StoredTurnSnapshot;
      snapshots.set(snapshot.id, snapshot);
      return snapshot;
    },

    forCompaction(id) {
      return this.get(id);
    },

    forRetry(id) {
      return this.get(id);
    },

    forTool(id) {
      return this.get(id);
    },

    get(id) {
      const snapshot = snapshots.get(id);
      if (!snapshot) {
        throw new Error(`unknown turn snapshot: ${id}`);
      }
      return snapshot;
    },
  };
}

function validateSnapshot(input: TurnConfigSnapshot): void {
  if (input.snapshotVersion !== 1) {
    throw new Error("unsupported turn snapshot version");
  }

  if (typeof input.routeId !== "string" || input.routeId.length === 0) {
    throw new Error("routeId must be a non-empty string");
  }

  if (typeof input.model !== "string" || input.model.length === 0) {
    throw new Error("model must be a non-empty string");
  }

  if (typeof input.parameters !== "object" || input.parameters === null) {
    throw new Error("parameters must be an object");
  }

  if (typeof input.promptContribution !== "string") {
    throw new Error("promptContribution must be a string");
  }

  if (typeof input.workspace !== "string" || input.workspace.length === 0) {
    throw new Error("workspace must be a non-empty string");
  }

  if (input.permission !== "workspace-write" && input.permission !== "full-access") {
    throw new Error("permission must be workspace-write or full-access");
  }

  if (input.sandboxPolicy !== "ask" && input.sandboxPolicy !== "deny") {
    throw new Error("sandboxPolicy must be ask or deny");
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}
