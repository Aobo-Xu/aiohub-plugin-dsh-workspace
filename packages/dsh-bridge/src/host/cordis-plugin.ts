import { createInterface } from "node:readline";
import { createDshHost } from "./create-host.js";
import { createRc1Adapter, RC1_SERVICE_EVIDENCE } from "../adapters/rc1.js";
import { createAuthoritativeSnapshot } from "../projections/snapshot.js";
import { createApprovalBroker } from "./interaction-broker.js";

type HostRequest = {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
};

type CordisContext = Record<string, unknown> & {
  fiber?: { dispose(): Promise<void> };
  root?: { fiber: { dispose(): Promise<void> } };
  agents?: {
    get(id: string): {
      whenIdle(): Promise<void>;
      session: {
        id: string;
        seq: number;
        eventAt(seq: number): { type?: string; data?: Record<string, unknown> } | undefined;
      };
    } | undefined;
  };
  on(
    event: "approval/request",
    listener: (request: {
      agent: {
        session: {
          id: string;
          seq: number;
          eventAt(seq: number): { type?: string; data?: Record<string, unknown> } | undefined;
        };
      };
      toolName: string;
      callId?: string;
      reason?: string;
      signal?: AbortSignal;
    }) => Promise<"allowed-once" | "rejected" | "cancelled" | "unavailable">,
  ): () => void;
};

export const name = "aiohub-dsh-host";
export const inject = [...RC1_SERVICE_EVIDENCE];

function trace(message: string): void {
  if (process.env.AIO_DSH_HOST_DIAGNOSTICS === "1") {
    process.stderr.write(`[aio-dsh-host] ${message}\n`);
  }
}

function writeFrame(frame: unknown): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function errorData(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    return { code: error.name || "HOST_ERROR", message: error.message };
  }
  return { code: "HOST_ERROR", message: String(error) };
}

/**
 * Cordis production entry loaded by the official DSH runtime.  It owns stdio
 * only after the complete public service set has settled, so `ready` is proof
 * that the release adapter is backed by the live runtime rather than fixtures.
 */
export async function apply(ctx: CordisContext): Promise<() => Promise<void>> {
  trace("apply entered");
  const adapter = createRc1Adapter({ runtime: { ctx } as never });
  const negotiated = await adapter.settle();
  trace(`adapter settled with ${negotiated.capabilities.length} capabilities`);
  const host = createDshHost({ adapter });
  host.applyNegotiation(negotiated.capabilities);
  const approvals = createApprovalBroker();
  const unregisterApproval = ctx.on("approval/request", (request) => approvals.open(request));
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let closed = false;

  async function dispatch(request: HostRequest): Promise<unknown> {
    const params = request.params ?? {};
    switch (request.method) {
      case "initialize":
        return {
          state: "ready",
          adapter: host.adapterIdentity,
          capabilities: host.capabilities(),
        };
      case "capabilities":
        return { capabilities: host.capabilities() };
      case "workspace.list": {
        const stream = await host.port("workspaces").follow?.(new AbortController().signal);
        if (stream === undefined) throw new Error("CAPABILITY_UNAVAILABLE: workspace.follow");
        const first = await stream[Symbol.asyncIterator]().next();
        if (first.done) throw new Error("INVALID_WORKSPACE_BASELINE");
        return first.value;
      }
      case "workspace.create":
        return await host.port("workspaces").create?.({ path: String(params.path ?? "") });
      case "session.list":
        return await host.port("sessions").list?.();
      case "session.create":
        return await host.port("sessions").create?.(params);
      case "session.open":
        return await host.port("sessions").open?.({ sessionId: String(params.sessionId ?? "") });
      case "session.snapshot":
      {
        const sessionId = String(params.sessionId ?? "");
        const value = await host.port("sessions").snapshot?.({ sessionId }) as Parameters<typeof createAuthoritativeSnapshot>[0]["value"];
        const snapshot = createAuthoritativeSnapshot({
          contractHash: String(params.contractHash ?? ""),
          domainGenerationId: String(params.domainGenerationId ?? ""),
          sessionId,
          adapterId: host.adapterIdentity.adapterId,
          releaseCommit: host.adapterIdentity.releaseCommit,
          value,
        });
        return { ...snapshot, activeInteractions: approvals.list(sessionId) };
      }
      case "session.submitPrompt":
      {
        const result = await host.port("sessions").submitPrompt?.(params);
        const sessionId = String(params.sessionId ?? "");
        const agent = ctx.agents?.get(sessionId);
        if (agent === undefined) throw new Error(`SESSION_AGENT_UNAVAILABLE: ${sessionId}`);
        // `prompt()` admits the user message and returns its acknowledgement;
        // the official Agent loop is driven by the idle barrier. Start that
        // barrier without holding the JSONL request open so a later cancel or
        // snapshot command can be serviced while the turn is running.
        void agent.whenIdle().catch((error: unknown) => {
          trace(`agent ${sessionId} settled with error: ${String(error)}`);
        });
        return result;
      }
      case "session.cancel":
        return await host.port("sessions").cancel?.({ sessionId: String(params.sessionId ?? "") });
      case "interaction.respond":
        return approvals.respond({
          correlationId: String(params.correlationId ?? ""),
          sessionId: String(params.sessionId ?? ""),
          decision: hostInteractionDecision(params.decision),
        });
      case "shutdown":
        closed = true;
        input.close();
        unregisterApproval();
        approvals.dispose();
        await host.dispose();
        return { state: "stopped" };
      default:
        throw new Error(`UNSUPPORTED_HOST_METHOD: ${request.method}`);
    }
  }

  input.on("line", (line) => {
    trace("request received");
    void (async () => {
      let request: HostRequest;
      try {
        request = JSON.parse(line) as HostRequest;
        if ((typeof request.id !== "number" && typeof request.id !== "string") || typeof request.method !== "string") {
          throw new Error("INVALID_HOST_REQUEST");
        }
        const data = await dispatch(request);
        writeFrame({ id: request.id, type: "result", data });
        if (request.method === "shutdown") {
          void ctx.root?.fiber.dispose();
        }
      } catch (error) {
        const id = typeof request! === "object" ? request!.id : null;
        writeFrame({ id, type: "error", data: errorData(error) });
      }
    })();
  });

  return async () => {
    if (!closed) {
      closed = true;
      input.close();
      unregisterApproval();
      approvals.dispose();
      await host.dispose();
    }
  };
}

function hostInteractionDecision(value: unknown): "allow" | "deny" | "cancel" | "timeout" {
  if (value === "allow" || value === "deny" || value === "cancel" || value === "timeout") return value;
  throw new Error("INVALID_INTERACTION_DECISION");
}

function lastAssistantText(events: ReadonlyArray<{ type?: string; data?: unknown }>): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "assistant/message" || typeof event.data !== "object" || event.data === null) continue;
    const message = (event.data as { message?: { content?: unknown } }).message;
    if (!Array.isArray(message?.content)) continue;
    const text = message.content
      .filter((block): block is { type: "text"; text: string } => (
        typeof block === "object" && block !== null
        && (block as { type?: unknown }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
      ))
      .map((block) => block.text)
      .join("");
    if (text !== "") return text;
  }
  return "";
}
