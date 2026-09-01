import { BridgeStartupError } from "./errors.js";

export const REQUIRED_SERVICES = [
  "gateway",
  "session",
  "workspace",
  "settings",
  "credentials",
  "systemPrompt",
] as const;

export type RequiredServiceName = (typeof REQUIRED_SERVICES)[number];

export function assertPublicServices(ctx: Record<string, unknown>): void {
  const missing = REQUIRED_SERVICES.filter((name) => ctx[name] === undefined);
  if (missing.length > 0) {
    throw new BridgeStartupError("MISSING_PUBLIC_SERVICES", { missing });
  }
}
