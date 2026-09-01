import { BridgeNotImplementedError } from "./errors.js";

export function createCredentialProvider(): never {
  throw new BridgeNotImplementedError("credential-provider");
}
