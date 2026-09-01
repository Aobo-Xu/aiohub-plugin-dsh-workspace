import { BridgeNotImplementedError } from "./errors.js";

export function createEventService(): never {
  throw new BridgeNotImplementedError("events");
}
