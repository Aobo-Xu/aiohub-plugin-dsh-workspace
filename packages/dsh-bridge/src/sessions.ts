import { BridgeNotImplementedError } from "./errors.js";

export function createSessionService(): never {
  throw new BridgeNotImplementedError("sessions");
}
