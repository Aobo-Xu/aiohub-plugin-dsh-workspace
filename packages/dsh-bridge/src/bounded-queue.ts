import { BridgeNotImplementedError } from "./errors.js";

export function createBoundedQueue(): never {
  throw new BridgeNotImplementedError("bounded-queue");
}
