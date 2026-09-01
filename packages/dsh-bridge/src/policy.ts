import { BridgeNotImplementedError } from "./errors.js";
import type { SandboxStatus } from "../../runtime-facade/src/types.js";

export type PermissionPolicy = {
  permission: "workspace-write" | "full-access";
  sandboxPolicy: "ask" | "deny";
};

export interface PermissionPolicyStore {
  nextTurn(): PermissionPolicy;
  grantOnce(permission: PermissionPolicy["permission"]): PermissionPolicy;
}

const DEFAULT_PERMISSION_POLICY: Readonly<PermissionPolicy> = Object.freeze({
  permission: "workspace-write",
  sandboxPolicy: "ask",
});

export function createPolicy(): never {
  throw new BridgeNotImplementedError("policy");
}

export function createPermissionPolicyStore(): PermissionPolicyStore {
  let oneTimeGrant: PermissionPolicy | undefined;

  return {
    nextTurn(): PermissionPolicy {
      const policy = oneTimeGrant ?? { ...DEFAULT_PERMISSION_POLICY };
      oneTimeGrant = undefined;
      return { ...policy };
    },
    grantOnce(permission: PermissionPolicy["permission"]): PermissionPolicy {
      oneTimeGrant = { permission, sandboxPolicy: "ask" };
      return { ...oneTimeGrant };
    },
  };
}

export function authorizeTask(
  policy: PermissionPolicy,
  sandbox: SandboxStatus,
): void {
  if (policy.permission === "full-access" && sandbox.level === "partial") {
    throw new Error("REQUIRED_SANDBOX_UNAVAILABLE");
  }
}
