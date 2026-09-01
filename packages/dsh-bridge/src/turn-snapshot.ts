import { BridgeNotImplementedError } from "./errors.js";

export function createTurnSnapshot(): never {
  throw new BridgeNotImplementedError("turn-snapshot");
}
