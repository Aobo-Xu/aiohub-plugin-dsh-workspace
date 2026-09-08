import type { RuntimeEvent, SessionSnapshot } from "../../runtime-facade/src/types.js";
import type { QueuedRuntimeEvent } from "./bounded-queue.js";
import { BridgeCommandError } from "./controller-leases.js";

export type RecoveryState = "ready" | "resync-required";

export interface SnapshotRecovery {
  accept(event: QueuedRuntimeEvent): "applied" | "coalesced" | "resync-required";
  applySnapshot(snapshot: SessionSnapshot): Promise<void>;
  durableFacts(): readonly RuntimeEvent[];
  state(): RecoveryState;
}

export function createSnapshotRecovery(options: {
  maxQueue: number;
}): SnapshotRecovery {
  if (!Number.isInteger(options.maxQueue) || options.maxQueue < 1) {
    throw new Error("maxQueue must be a positive integer");
  }

  let currentGeneration: string | undefined;
  let lastSeq = 0;
  let recoveryState: RecoveryState = "ready";
  const durableFacts: RuntimeEvent[] = [];

  return {
    accept(event) {
      if (recoveryState === "resync-required") {
        return "resync-required";
      }
      if (
        currentGeneration !== undefined &&
        event.generation !== currentGeneration
      ) {
        recoveryState = "resync-required";
        return "resync-required";
      }

      if (event.seq <= lastSeq) {
        return "coalesced";
      }

      if (event.seq > lastSeq + 1) {
        recoveryState = "resync-required";
        return "resync-required";
      }

      currentGeneration = event.generation;
      lastSeq = event.seq;
      recoveryState = "ready";

      if (event.durability === "durable") {
        durableFacts.push(event.payload);
      }

      return "applied";
    },

    async applySnapshot(snapshot) {
      if (
        snapshot.source !== "dsh" ||
        snapshot.durableFacts.length === 0 ||
        snapshot.seq < 0 ||
        snapshot.cursor.length === 0
      ) {
        recoveryState = "resync-required";
        throw new BridgeCommandError("INVALID_DSH_SNAPSHOT");
      }
      currentGeneration = snapshot.domainGenerationId;
      lastSeq = snapshot.seq;
      recoveryState = "ready";
      durableFacts.length = 0;
      durableFacts.push(...snapshot.durableFacts);
    },

    durableFacts() {
      return [...durableFacts];
    },

    state() {
      return recoveryState;
    },
  };
}
