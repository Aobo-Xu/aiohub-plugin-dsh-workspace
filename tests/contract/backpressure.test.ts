import { describe, expect, it } from "vitest";
import { createBoundedQueue } from "../../packages/dsh-bridge/src/bounded-queue.js";
import { createEventService } from "../../packages/dsh-bridge/src/events.js";
import type { RuntimeEvent } from "../../packages/runtime-facade/src/types.js";

function event(kind: string, data: unknown = {}): RuntimeEvent {
  return { kind, sessionId: "session-1", turnId: "turn-1", data };
}

describe("bounded queue", () => {
  it("exposes overload diagnostics without hiding durable admission failures", () => {
    const queue = createBoundedQueue({ maxQueue: 1 });
    queue.push({
      seq: 1,
      generation: "generation-1",
      durability: "durable",
      correlationId: "event-1",
      payload: event("start"),
    });

    expect(queue.push({
      seq: 2,
      generation: "generation-1",
      durability: "durable",
      correlationId: "event-2",
      payload: event("error"),
    })).toBe("overloaded");
    expect(queue.diagnostics()).toEqual({ overloaded: 1, droppedDisposable: 0, evictedDisposable: 0 });
  });

  it("keeps durable events when disposable events overflow", () => {
    const queue = createBoundedQueue({ maxQueue: 2 });

    expect(queue.push({
      seq: 1,
      generation: "generation-1",
      durability: "durable",
      correlationId: "event-1",
      payload: event("start"),
    })).toBe("applied");

    expect(queue.push({
      seq: 2,
      generation: "generation-1",
      durability: "disposable",
      correlationId: "event-2",
      payload: event("token-delta"),
    })).toBe("applied");

    expect(queue.push({
      seq: 3,
      generation: "generation-1",
      durability: "disposable",
      correlationId: "event-3",
      payload: event("token-delta"),
    })).toBe("overloaded");

    expect(queue.size()).toBe(2);
    expect(queue.peek()?.durability).toBe("durable");
  });

  it("evicts the oldest disposable event to admit a durable event", () => {
    const queue = createBoundedQueue({ maxQueue: 2 });
    queue.push({
      seq: 1,
      generation: "generation-1",
      durability: "disposable",
      correlationId: "event-1",
      payload: event("token-delta"),
    });
    queue.push({
      seq: 2,
      generation: "generation-1",
      durability: "disposable",
      correlationId: "event-2",
      payload: event("token-delta"),
    });

    expect(queue.push({
      seq: 3,
      generation: "generation-1",
      durability: "durable",
      correlationId: "event-3",
      payload: event("error"),
    })).toBe("applied");

    expect(queue.size()).toBe(2);
    expect(queue.items().some((item) => item.durability === "durable")).toBe(true);
  });

  it("reports overload instead of silently dropping durable events", () => {
    const queue = createBoundedQueue({ maxQueue: 1 });
    queue.push({
      seq: 1,
      generation: "generation-1",
      durability: "durable",
      correlationId: "event-1",
      payload: event("start"),
    });

    const result = queue.push({
      seq: 2,
      generation: "generation-1",
      durability: "durable",
      correlationId: "event-2",
      payload: event("error"),
    });

    expect(result).toBe("overloaded");
    expect(queue.size()).toBe(1);
    expect(queue.items()[0]?.payload).toEqual(event("start"));
  });
});

describe("event service", () => {
  it("coalesces disposable events with the same correlation id", () => {
    const service = createEventService({ maxQueue: 4 });
    const first = {
      seq: 1,
      generation: "generation-1",
      durability: "disposable" as const,
      correlationId: "delta-1",
      payload: event("token-delta", { text: "a" }),
    };
    const second = {
      seq: 2,
      generation: "generation-1",
      durability: "disposable" as const,
      correlationId: "delta-1",
      payload: event("token-delta", { text: "ab" }),
    };

    expect(service.accept(first)).toBe("applied");
    expect(service.accept(second)).toBe("coalesced");
    expect(service.pending()).toHaveLength(1);
    expect(service.pending()[0]?.payload).toEqual(event("token-delta", { text: "ab" }));
  });

  it("does not coalesce durable events", () => {
    const service = createEventService({ maxQueue: 4 });

    expect(service.accept({
      seq: 1,
      generation: "generation-1",
      durability: "durable",
      correlationId: "tool-1",
      payload: event("tool-result"),
    })).toBe("applied");

    expect(service.accept({
      seq: 2,
      generation: "generation-1",
      durability: "durable",
      correlationId: "tool-1",
      payload: event("tool-result"),
    })).toBe("applied");

    expect(service.pending()).toHaveLength(2);
  });
});
