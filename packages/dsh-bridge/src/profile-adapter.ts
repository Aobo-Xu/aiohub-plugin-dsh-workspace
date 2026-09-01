import { BridgeNotImplementedError } from "./errors.js";

export function createProfileAdapter(): never {
  throw new BridgeNotImplementedError("profile-adapter");
}
