import type {
  AcquireSessionInput,
  ControllerLease,
  InitializeInput,
  InitializeResult,
  RuntimeCommand,
  RuntimeEvent,
  RuntimeFacade,
  SessionSnapshot,
  SidecarTransport,
  TransferControllerInput,
} from "./types.js";

export class SidecarRuntimeFacade implements RuntimeFacade {
  public constructor(private readonly transport: SidecarTransport) {}

  public initialize(input: InitializeInput): Promise<InitializeResult> {
    return this.transport.request("initialize", input);
  }

  public acquireSession(input: AcquireSessionInput): Promise<ControllerLease> {
    return this.transport.request("acquireSession", input);
  }

  public transferController(
    input: TransferControllerInput
  ): Promise<ControllerLease> {
    return this.transport.request("transferController", input);
  }

  public command<T>(
    lease: ControllerLease,
    command: RuntimeCommand
  ): Promise<T> {
    return this.transport.request("command", { lease, command });
  }

  public snapshot(sessionId: string, cursor?: string): Promise<SessionSnapshot> {
    return this.transport.request("snapshot", { sessionId, cursor });
  }

  public subscribe(listener: (event: RuntimeEvent) => void): () => void {
    return this.transport.onEvent((value) => {
      if (!isRuntimeEvent(value)) {
        throw new Error("DSH runtime emitted an invalid RuntimeEvent.");
      }
      listener(value);
    });
  }

  public shutdown(
    _reason: "plugin-disabled" | "aio-exit" | "user-stop"
  ): Promise<void> {
    return this.transport.kill();
  }
}

function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof value.kind === "string" &&
    "data" in value
  );
}
