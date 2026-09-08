import { BridgeCommandError } from "../controller-leases.js";
import type { OperationAvailability } from "../../../runtime-facade/src/types.js";

type TerminalPort = {
  operationAvailability(id: string): OperationAvailability;
  open?(input: { sessionId: string; type?: string; name?: string }): Promise<{ handleId: string; motd?: string }>;
  send?(input: { sessionId: string; handleId: string; text: string; submit: boolean }): Promise<unknown>;
  resize?(input: { sessionId: string; handleId: string; cols: number; rows: number }): Promise<unknown>;
  interrupt?(input: { sessionId: string; handleId: string }): Promise<unknown>;
  close?(input: { sessionId: string; handleId: string }): Promise<unknown>;
};

export type TerminalHandle = {
  handleId: string;
  sessionId: string;
  generation: string;
  state: "running" | "interrupted" | "closed";
  motd?: string;
};

export function createTerminalService(options: { port: TerminalPort }) {
  const handles = new Map<string, TerminalHandle>();
  const { port } = options;

  return {
    async open(input: { sessionId: string; generation: string; type?: string; name?: string }): Promise<TerminalHandle> {
      requireOperation(port, "terminal.open", "open");
      const value = await port.open!({ sessionId: input.sessionId, type: input.type, name: input.name });
      const handle: TerminalHandle = {
        handleId: value.handleId,
        sessionId: input.sessionId,
        generation: input.generation,
        state: "running",
        ...(value.motd === undefined ? {} : { motd: value.motd }),
      };
      handles.set(handle.handleId, handle);
      return { ...handle };
    },

    async input(handleId: string, input: { sessionId: string; generation: string; text: string; submit?: boolean }): Promise<unknown> {
      const handle = writable(handles, handleId, input.sessionId, input.generation);
      requireOperation(port, "terminal.send", "send");
      return port.send!({ sessionId: handle.sessionId, handleId, text: input.text, submit: input.submit ?? true });
    },

    async resize(handleId: string, input: { sessionId: string; generation: string; cols: number; rows: number }): Promise<unknown> {
      const handle = writable(handles, handleId, input.sessionId, input.generation);
      requireOperation(port, "terminal.resize", "resize");
      return port.resize!({ sessionId: handle.sessionId, handleId, cols: input.cols, rows: input.rows });
    },

    async interrupt(handleId: string, input: { sessionId: string; generation: string }): Promise<unknown> {
      const handle = writable(handles, handleId, input.sessionId, input.generation);
      requireOperation(port, "terminal.interrupt", "interrupt");
      const result = await port.interrupt!({ sessionId: handle.sessionId, handleId });
      handle.state = "interrupted";
      return result;
    },

    async close(handleId: string, input: { sessionId: string; generation: string }): Promise<unknown> {
      const handle = writable(handles, handleId, input.sessionId, input.generation);
      requireOperation(port, "terminal.close", "close");
      const result = await port.close!({ sessionId: handle.sessionId, handleId });
      handle.state = "closed";
      return result;
    },

    async stopGeneration(generation: string): Promise<void> {
      for (const handle of handles.values()) {
        if (handle.generation !== generation || handle.state !== "running") continue;
        if (port.operationAvailability("terminal.close").available && port.close) {
          await port.close({ sessionId: handle.sessionId, handleId: handle.handleId });
        }
        handle.state = "interrupted";
      }
    },

    get(handleId: string): TerminalHandle | undefined {
      const handle = handles.get(handleId);
      return handle === undefined ? undefined : { ...handle };
    },
  };
}

function writable(handles: Map<string, TerminalHandle>, handleId: string, sessionId: string, generation: string): TerminalHandle {
  const handle = handles.get(handleId);
  if (handle === undefined) throw new BridgeCommandError("UNKNOWN_TERMINAL");
  if (handle.sessionId !== sessionId || handle.generation !== generation || handle.state !== "running") {
    throw new BridgeCommandError("TERMINAL_NOT_WRITABLE");
  }
  return handle;
}

function requireOperation(port: TerminalPort, id: string, method: keyof TerminalPort): void {
  if (!port.operationAvailability(id).available || typeof port[method] !== "function") {
    throw new BridgeCommandError("CAPABILITY_UNAVAILABLE", id);
  }
}
