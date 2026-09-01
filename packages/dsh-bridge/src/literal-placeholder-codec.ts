import { BridgeNotImplementedError } from "./errors.js";

export function createLiteralPlaceholderCodec(): never {
  throw new BridgeNotImplementedError("literal-placeholder-codec");
}
