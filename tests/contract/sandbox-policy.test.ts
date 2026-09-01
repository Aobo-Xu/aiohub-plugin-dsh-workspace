import { describe, expect, it } from "vitest";
import {
  authorizeTask,
  createPermissionPolicyStore,
} from "../../packages/dsh-bridge/src/policy.js";
import type { SandboxStatus } from "../../packages/runtime-facade/src/types.js";

const fullSandbox: SandboxStatus = {
  level: "full",
  backend: "seatbelt",
};

const partialSandbox: SandboxStatus = {
  level: "partial",
  backend: "restricted-token",
  reason: "restricted token plus ACL",
};

describe("DSH permission policy", () => {
  it("defaults the next turn to workspace-write with ask", () => {
    const store = createPermissionPolicyStore();

    expect(store.nextTurn()).toEqual({
      permission: "workspace-write",
      sandboxPolicy: "ask",
    });
  });

  it("grants full access once without persisting it as the default", () => {
    const store = createPermissionPolicyStore();

    expect(store.grantOnce("full-access")).toEqual({
      permission: "full-access",
      sandboxPolicy: "ask",
    });
    expect(store.nextTurn()).toEqual({
      permission: "full-access",
      sandboxPolicy: "ask",
    });
    expect(store.nextTurn()).toEqual({
      permission: "workspace-write",
      sandboxPolicy: "ask",
    });
  });

  it("rejects a task when full access requires an unavailable sandbox", () => {
    expect(() =>
      authorizeTask(
        { permission: "full-access", sandboxPolicy: "ask" },
        partialSandbox,
      ),
    ).toThrowError("REQUIRED_SANDBOX_UNAVAILABLE");
  });

  it("rejects full access when the reported level does not match backend capability", () => {
    expect(() =>
      authorizeTask(
        { permission: "full-access", sandboxPolicy: "ask" },
        {
          level: "full",
          backend: "bwrap",
          reason: "bwrap preferred; landlock fallback",
        },
      ),
    ).toThrowError("REQUIRED_SANDBOX_UNAVAILABLE");
  });

  it("allows a task when the selected permission is covered by the sandbox", () => {
    expect(() =>
      authorizeTask(
        { permission: "full-access", sandboxPolicy: "ask" },
        fullSandbox,
      ),
    ).not.toThrow();
    expect(() =>
      authorizeTask(
        { permission: "workspace-write", sandboxPolicy: "ask" },
        partialSandbox,
      ),
    ).not.toThrow();
  });
});
