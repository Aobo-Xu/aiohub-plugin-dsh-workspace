export type FacadeCompositionErrorCode =
  | "PLUGIN_NOT_ACTIVE"
  | "PLUGIN_PROXY_INVALID"
  | "INITIALIZE_FAILED"
  | "CONTRACT_MISMATCH"
  | "REQUIRED_CAPABILITY_MISSING";

export class FacadeCompositionError extends Error {
  public readonly code: FacadeCompositionErrorCode;
  public readonly missingCapabilities: readonly string[];
  public readonly cause?: unknown;

  public constructor(init: {
    code: FacadeCompositionErrorCode;
    message: string;
    missingCapabilities?: readonly string[];
    cause?: unknown;
  }) {
    super(init.message);
    this.name = "FacadeCompositionError";
    this.code = init.code;
    this.missingCapabilities = init.missingCapabilities ?? [];
    if ("cause" in init) {
      this.cause = init.cause;
    }
  }
}
