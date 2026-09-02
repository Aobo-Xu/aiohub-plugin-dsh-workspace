import { createBoundedQueue, type BoundedQueue, type QueuedRuntimeEvent } from "./bounded-queue.js";

export type {
  BoundedQueue,
  Durability,
  QueuedRuntimeEvent,
  QueuePushResult,
} from "./bounded-queue.js";

export function createEventService(options: { maxQueue: number }) {
  const queue: BoundedQueue = createBoundedQueue(options);

  return {
    accept(event: QueuedRuntimeEvent) {
      return queue.push(event);
    },

    pending() {
      return queue.items();
    },

    size() {
      return queue.size();
    },
  };
}
