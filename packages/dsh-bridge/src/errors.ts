export type BridgeStartupErrorDetails = Readonly<Record<string, unknown>>;

export class BridgeStartupError extends Error {
  public readonly code: string;
  public readonly details: BridgeStartupErrorDetails;

  public constructor(code: string, details: BridgeStartupErrorDetails = {}) {
    super(formatBridgeStartupMessage(code, details));
    this.name = "BridgeStartupError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export class BridgeNotImplementedError extends Error {
  public readonly code = "BRIDGE_NOT_IMPLEMENTED";
  public readonly feature: string;

  public constructor(feature: string) {
    super(`DSH bridge feature "${feature}" is not implemented yet.`);
    this.name = "BridgeNotImplementedError";
    this.feature = feature;
  }
}

function formatBridgeStartupMessage(
  code: string,
  details: Readonly<Record<string, unknown>>,
): string {
  const suffix = Object.entries(details)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");
  return suffix
    ? `DSH bridge startup failed: ${code} (${suffix})`
    : `DSH bridge startup failed: ${code}`;
}
