import type { RuntimeEvent } from "../../runtime-facade/src/types.js";

export type Durability = "durable" | "disposable";

export type QueuedRuntimeEvent = {
  seq: number;
  generation: string;
  durability: Durability;
  correlationId?: string;
  payload: RuntimeEvent;
};

export type QueuePushResult = "applied" | "coalesced" | "overloaded";

export interface BoundedQueue {
  items(): readonly QueuedRuntimeEvent[];
  peek(): QueuedRuntimeEvent | undefined;
  push(event: QueuedRuntimeEvent): QueuePushResult;
  size(): number;
}

export function createBoundedQueue(options: { maxQueue: number }): BoundedQueue {
  if (!Number.isInteger(options.maxQueue) || options.maxQueue < 1) {
    throw new Error("maxQueue must be a positive integer");
  }

  const items: QueuedRuntimeEvent[] = [];

  return {
    items() {
      return [...items];
    },

    peek() {
      return items[0];
    },

    push(event) {
      validateEvent(event);

      if (
        event.durability === "disposable" &&
        event.correlationId !== undefined
      ) {
        const existingIndex = items.findIndex(
          (item) =>
            item.durability === "disposable" &&
            item.correlationId === event.correlationId,
        );

        if (existingIndex >= 0) {
          items[existingIndex] = {
            ...event,
            seq: Math.max(items[existingIndex].seq, event.seq),
          };
          return "coalesced";
        }
      }

      if (items.length >= options.maxQueue) {
        if (event.durability === "disposable") {
          return "overloaded";
        }

        const disposableIndex = items.findIndex(
          (item) => item.durability === "disposable",
        );

        if (disposableIndex === -1) {
          return "overloaded";
        }

        items.splice(disposableIndex, 1);
      }

      items.push(event);
      return "applied";
    },

    size() {
      return items.length;
    },
  };
}

function validateEvent(event: QueuedRuntimeEvent): void {
  if (!Number.isInteger(event.seq) || event.seq < 0) {
    throw new Error("event seq must be a non-negative integer");
  }

  if (typeof event.generation !== "string" || event.generation.length === 0) {
    throw new Error("event generation must be a non-empty string");
  }

  if (event.durability !== "durable" && event.durability !== "disposable") {
    throw new Error("event durability must be durable or disposable");
  }

  if (event.correlationId !== undefined && typeof event.correlationId !== "string") {
    throw new Error("event correlationId must be a string when provided");
  }

  if (typeof event.payload !== "object" || event.payload === null) {
    throw new Error("event payload must be an object");
  }
}
