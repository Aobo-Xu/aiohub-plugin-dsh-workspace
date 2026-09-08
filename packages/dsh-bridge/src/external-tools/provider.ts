import { BridgeCommandError } from "../controller-leases.js";

export type ProviderDescriptor = {
  providerId: string;
  displayName: string;
  capabilities: readonly string[];
};

export type CatalogSnapshot = {
  providerId: string;
  cursor?: string;
  tools: readonly Record<string, unknown>[];
};

export type ToolInvocationRequest = {
  invocationId: string;
  toolId: string;
  input: unknown;
};

export type ToolInvocationEvent = {
  invocationId: string;
  kind: "started" | "output" | "completed" | "failed" | "cancelled";
  data?: unknown;
};

export interface ExternalToolProvider {
  connect(): Promise<ProviderDescriptor>;
  catalog(cursor?: string): Promise<CatalogSnapshot>;
  invoke(request: ToolInvocationRequest): Promise<AsyncIterable<ToolInvocationEvent>>;
  cancel(invocationId: string): Promise<void>;
  refresh(): Promise<CatalogSnapshot>;
  drain(): Promise<void>;
  disconnect(): Promise<void>;
}

export function createExternalToolProvider(provider?: ExternalToolProvider): ExternalToolProvider {
  if (provider) return provider;
  const unavailable = (capabilityId: string): never => {
    throw new BridgeCommandError("CAPABILITY_UNAVAILABLE", capabilityId);
  };
  return {
    connect: async () => unavailable("external-tools.connect"),
    catalog: async () => unavailable("external-tools.catalog"),
    invoke: async () => unavailable("external-tools.invoke"),
    cancel: async () => unavailable("external-tools.cancel"),
    refresh: async () => unavailable("external-tools.refresh"),
    drain: async () => unavailable("external-tools.drain"),
    disconnect: async () => unavailable("external-tools.disconnect"),
  };
}
