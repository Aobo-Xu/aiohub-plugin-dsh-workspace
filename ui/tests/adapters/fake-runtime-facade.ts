/**
 * Test-only adapter: a scripted stand-in for the AIO PluginProxy. It drives
 * the real AioSidecarTransport + SidecarRuntimeFacade path so composition
 * tests exercise production code, and must never be imported by ui/src.
 */
export const TEST_CONTRACT_HASH = "test-contract-hash";
export const TEST_DOMAIN_GENERATION_ID = "gen-test-1";

export type FakeInitializeScript = {
  state?: string;
  capabilities?: readonly string[];
  contractHash?: string;
  domainGenerationId?: string;
  initializeError?: unknown;
  initializeResult?: unknown;
};

export type RecordedCall = { method: string; params: unknown };

export function defaultInitializeResult(script: FakeInitializeScript = {}) {
  return {
    domainGenerationId: script.domainGenerationId ?? TEST_DOMAIN_GENERATION_ID,
    contractHash: script.contractHash ?? TEST_CONTRACT_HASH,
    state: script.state ?? "ready",
    capabilities: [...(script.capabilities ?? [])],
    sandbox: { level: "full", backend: "restricted-token" },
  };
}

export class FakePluginProxy {
  public readonly calls: RecordedCall[] = [];

  public constructor(private readonly script: FakeInitializeScript = {}) {}

  public async initialize(params: unknown): Promise<unknown> {
    this.calls.push({ method: "initialize", params });
    if (this.script.initializeError !== undefined) {
      throw this.script.initializeError;
    }
    return this.script.initializeResult ?? defaultInitializeResult(this.script);
  }

  public async acquireSession(params: unknown): Promise<unknown> {
    this.calls.push({ method: "acquireSession", params });
    return {
      domainGenerationId: TEST_DOMAIN_GENERATION_ID,
      contractHash: TEST_CONTRACT_HASH,
      sessionId: "session-1",
      leaseId: "lease-1",
      mode: "controller",
    };
  }

  public async transferController(params: unknown): Promise<unknown> {
    this.calls.push({ method: "transferController", params });
    return {
      domainGenerationId: TEST_DOMAIN_GENERATION_ID,
      contractHash: TEST_CONTRACT_HASH,
      sessionId: "session-1",
      leaseId: "lease-2",
      mode: "controller",
    };
  }

  public async command(params: unknown): Promise<unknown> {
    this.calls.push({ method: "command", params });
    return { accepted: true };
  }

  public async snapshot(params: unknown): Promise<unknown> {
    this.calls.push({ method: "snapshot", params });
    return {
      domainGenerationId: TEST_DOMAIN_GENERATION_ID,
      contractHash: TEST_CONTRACT_HASH,
      source: "dsh",
      provenance: { adapterId: "fake-adapter" },
      sessionId: "session-1",
      cursor: "cursor-0",
      seq: 0,
      durableFacts: [],
    };
  }

  public async shutdown(params: unknown): Promise<void> {
    this.calls.push({ method: "shutdown", params });
  }

  public onSidecarEvent(_eventName: string, _callback: (data: unknown) => void): () => void {
    return () => {};
  }

  public async disable(): Promise<void> {}
}
