import { BridgeNotImplementedError } from "./errors.js";

export function createPromptContribution(): never {
  throw new BridgeNotImplementedError("prompt-contribution");
}
