import { BridgeNotImplementedError } from "./errors.js";

export function createControllerLeaseService(): never {
  throw new BridgeNotImplementedError("controller-leases");
}
