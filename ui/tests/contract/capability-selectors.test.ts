import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getActionAvailability, type ActionContext } from "../../src/facade/capability-selectors";
import { WORKSTATION_FEATURES, featureById } from "../../src/facade/feature-map";

import type {
  OperationAvailability,
  UnavailableReasonCode,
} from "@aiohub/dsh-runtime-facade/types";

type AvailabilityStub = (capabilityId: string) => OperationAvailability;

function context(overrides: Partial<ActionContext> = {}): ActionContext {
  const availability: AvailabilityStub = () => ({ available: true });
  return {
    runtimeState: "ready",
    leaseMode: "controller",
    availability,
    ...overrides,
  };
}

const unavailable =
  (code: UnavailableReasonCode): AvailabilityStub =>
  () => ({ available: false, reason: { code } });

describe("getActionAvailability", () => {
  it("disables an action whose capability was never negotiated", () => {
    const result = getActionAvailability(
      context({ availability: unavailable("CAPABILITY_NOT_NEGOTIATED") }),
      "session.create",
    );
    expect(result.enabled).toBe(false);
    if (!result.enabled) {
      expect(result.reason.code).toBe("CAPABILITY_UNAVAILABLE");
      expect(result.reason.hostReasonCode).toBe("CAPABILITY_NOT_NEGOTIATED");
    }
  });

  it("disables every action while the runtime is unavailable", () => {
    for (const state of ["loading", "starting", "crashed", "unavailable", "incompatible"] as const) {
      const result = getActionAvailability(context({ runtimeState: state }), "session.history");
      expect(result.enabled).toBe(false);
      if (!result.enabled) expect(result.reason.code).toBe("RUNTIME_UNAVAILABLE");
    }
  });

  it("lets an observer read but never mutate", () => {
    const read = getActionAvailability(context({ leaseMode: "observer" }), "session.history");
    expect(read.enabled).toBe(true);

    const mutate = getActionAvailability(context({ leaseMode: "observer" }), "session.rename");
    expect(mutate.enabled).toBe(false);
    if (!mutate.enabled) expect(mutate.reason.code).toBe("OBSERVER_READ_ONLY");
  });

  it("fences mutations during a pending control transfer but keeps reads", () => {
    const read = getActionAvailability(context({ transferPending: true }), "session.history");
    expect(read.enabled).toBe(true);

    const mutate = getActionAvailability(context({ transferPending: true }), "session.rename");
    expect(mutate.enabled).toBe(false);
    if (!mutate.enabled) expect(mutate.reason.code).toBe("TRANSFER_PENDING");
  });

  it("disables everything against a stale generation", () => {
    for (const featureId of ["session.history", "session.rename"]) {
      const result = getActionAvailability(context({ generationStale: true }), featureId);
      expect(result.enabled).toBe(false);
      if (!result.enabled) expect(result.reason.code).toBe("STALE_GENERATION");
    }
  });

  it("enables an advertised action for a controller in a ready runtime", () => {
    const result = getActionAvailability(context(), "session.create");
    expect(result.enabled).toBe(true);
  });

  it("keeps busy-runtime actions delegated to Host semantics", () => {
    const result = getActionAvailability(context({ runtimeState: "busy" }), "session.history");
    expect(result.enabled).toBe(true);
  });

  it("fails closed for unknown feature ids", () => {
    const result = getActionAvailability(context(), "not-a-feature");
    expect(result.enabled).toBe(false);
  });
});

describe("feature map", () => {
  it("maps every feature to exactly one raw capability", () => {
    const ids = new Set<string>();
    for (const feature of WORKSTATION_FEATURES) {
      expect(feature.capabilityId).toBeTruthy();
      expect(ids.has(feature.featureId)).toBe(false);
      ids.add(feature.featureId);
      expect(featureById(feature.featureId)).toBe(feature);
    }
  });

  it("contains no DSH version or release-specific branching strings", () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/facade");
    for (const file of ["feature-map.ts", "capability-selectors.ts"]) {
      const text = readFileSync(path.join(dir, file), "utf8");
      expect(/0\.1\.|rc\.\d|alpha|dsh-v\d/i.test(text)).toBe(false);
    }
  });
});
