import { describe, expect, it } from "vitest";
import { createControllerLeaseService } from "../../packages/dsh-bridge/src/controller-leases.js";
import { createInteractionService } from "../../packages/dsh-bridge/src/interactions.js";

const runtimeRef = {
  domainGenerationId: "generation-1",
  contractHash: "contract-hash-1",
} as const;

function request(correlationId: string) {
  return {
    ...runtimeRef,
    sessionId: "session-1",
    correlationId,
    kind: "approval",
    data: {},
  };
}

function leaseRef() {
  return {
    ...runtimeRef,
    sessionId: "session-1",
    leaseId: "lease-1",
    mode: "controller",
  };
}

async function createHarness() {
  const leases = createControllerLeaseService();
  const controller = await leases.acquire({
    ...runtimeRef,
    sessionId: "session-1",
    viewId: "view-a",
    requestedMode: "controller",
  });
  const interactions = createInteractionService({
    assertMutable: leases.assertMutable,
  });
  return { controller, interactions, leases };
}

describe("interaction registry", () => {
  it("resolves exactly once and records the terminal reason", async () => {
    const { controller, interactions } = await createHarness();
    interactions.open(request("approval-1"));

    await interactions.resolveOnce(
      {
        ...controller,
        correlationId: "approval-1",
      },
      { kind: "allow-once" },
    );

    await expect(
      interactions.resolveOnce(
        {
          ...controller,
          correlationId: "approval-1",
        },
        { kind: "allow-once" },
      ),
    ).rejects.toMatchObject({ code: "INTERACTION_RESOLVED" });
  });

  it("rejects a stale lease", async () => {
    const { controller, interactions } = await createHarness();
    interactions.open(request("approval-1"));
    const stale = { ...controller, leaseId: "lease-0" };

    await expect(
      interactions.resolveOnce(
        {
          ...stale,
          correlationId: "approval-1",
        },
        { kind: "allow-once" },
      ),
    ).rejects.toMatchObject({ code: "STALE_LEASE" });
  });

  it("rejects a stale generation", async () => {
    const { controller, interactions } = await createHarness();
    interactions.open(request("approval-1"));
    const stale = { ...controller, domainGenerationId: "generation-0" };

    await expect(
      interactions.resolveOnce(
        {
          ...stale,
          correlationId: "approval-1",
        },
        { kind: "allow-once" },
      ),
    ).rejects.toMatchObject({ code: "STALE_GENERATION" });
  });

  it("rejects an unknown interaction", async () => {
    const { controller, interactions } = await createHarness();

    await expect(
      interactions.resolveOnce(
        {
          ...controller,
          correlationId: "approval-1",
        },
        { kind: "allow-once" },
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN_INTERACTION" });
  });

  it("resolves every pending interaction for a generation", async () => {
    const { interactions } = await createHarness();
    interactions.open(request("approval-1"));
    interactions.open(request("approval-2"));
    interactions.open({
      ...request("approval-3"),
      domainGenerationId: "generation-2",
    });

    const resolved = interactions.resolveGeneration("generation-1", "transferred");

    expect(resolved).toHaveLength(2);
    expect(resolved.map((entry) => entry.correlationId)).toEqual([
      "approval-1",
      "approval-2",
    ]);
    expect(resolved.every((entry) => entry.reason === "transferred")).toBe(true);
  });
});
