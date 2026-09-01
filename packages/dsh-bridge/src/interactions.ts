import { BridgeNotImplementedError } from "./errors.js";

export function createInteractionService(): never {
  throw new BridgeNotImplementedError("interactions");
}
