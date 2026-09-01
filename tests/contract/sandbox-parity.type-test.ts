import type { SandboxStatus as ProtocolSandboxStatus } from "../../generated/protocol.js";
import type { SandboxStatus as FacadeSandboxStatus } from "../../packages/runtime-facade/src/types.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Assert<Condition extends true> = Condition;

export type SandboxBackendContractParity = Assert<
  Equal<ProtocolSandboxStatus["backend"], FacadeSandboxStatus["backend"]>
>;
