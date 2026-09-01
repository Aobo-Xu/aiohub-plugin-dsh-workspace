import { BridgeNotImplementedError } from "./errors.js";

export function createPolicy(): never {
  throw new BridgeNotImplementedError("policy");
}
