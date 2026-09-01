import { BridgeNotImplementedError } from "./errors.js";

export function createSnapshotRecovery(): never {
  throw new BridgeNotImplementedError("snapshot-recovery");
}
