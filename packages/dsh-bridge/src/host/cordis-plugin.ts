import { createInterface } from "node:readline";
import { createDshHost } from "./create-host.js";
import { createRc1Adapter, RC1_SERVICE_EVIDENCE } from "../adapters/rc1.js";
import { createAuthoritativeSnapshot } from "../projections/snapshot.js";
import { createApprovalBroker } from "./interaction-broker.js";
import { createContextSummary } from "../projections/context-summary.js";
import type { DshHost, HostPortName } from "./create-host.js";

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

const HOST_OWNED_CAPABILITIES = [{
  capabilityId: "attachment.limits",
  schemaRevision: 1,
  stability: "stable" as const,
  mode: "read" as const,
}];

const HOST_METHOD_CAPABILITIES: Readonly<Record<string, string>> = Object.freeze({
  "workspace.list": "workspace.follow",
  "workspace.open": "workspace.follow",
  "workspace.create": "workspace.create",
  "workspace.rename": "workspace.rename",
  "workspace.remove": "workspace.delete",
  "workspace.archiveSession": "workspace.archive-session",
  "session.list": "session.list",
  "session.open": "session.open",
  "session.create": "session.create",
  "session.search": "session.search",
  "session.history": "session.history",
  "session.resume": "session.resume",
  "session.rename": "session.rename",
  "session.restoreArchive": "session.restore-archive",
  "session.delete": "session.delete",
  "session.fork": "session.fork",
  "session.updateQueue": "session.update-queue",
  "session.restart": "session.restart",
  "terminal.open": "terminal.open",
  "terminal.read": "terminal.read",
  "terminal.list": "terminal.open",
  "terminal.input": "terminal.send",
  "terminal.resize": "terminal.resize",
  "terminal.interrupt": "terminal.interrupt",
  "terminal.close": "terminal.close",
  "preset.catalog": "preset.catalog",
  "preset.select": "preset.select",
  "dynamic.host.define": "dynamic.host.define",
  "dynamic.host.run": "dynamic.host.run",
  "dynamic.host.update": "dynamic.host.update",
  "dynamic.host.stop": "dynamic.host.stop",
  "dynamic.host.undefine": "dynamic.host.undefine",
  "dynamic.host.inventory": "dynamic.host.inventory",
  "dynamic.host.diagnostics": "dynamic.host.diagnostics",
  "attachment.limits": "attachment.limits",
  "context.summary": "session.snapshot",
});

export function hostMethodCapability(method: string): string | undefined {
  return HOST_METHOD_CAPABILITIES[method];
}

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
          capabilities: [...host.capabilities(), ...HOST_OWNED_CAPABILITIES],
        };
      case "capabilities":
        return { capabilities: [...host.capabilities(), ...HOST_OWNED_CAPABILITIES] };
      case "workspace.list": {
        const stream = await host.port("workspaces").follow?.(new AbortController().signal);
        if (stream === undefined) throw new Error("CAPABILITY_UNAVAILABLE: workspace.follow");
        const first = await stream[Symbol.asyncIterator]().next();
        if (first.done) throw new Error("INVALID_WORKSPACE_BASELINE");
        const baseline = first.value as { type?: string; value?: unknown };
        if (baseline.type !== "baseline" || baseline.value === undefined) {
          throw new Error("INVALID_WORKSPACE_BASELINE");
        }
        return baseline.value;
      }
      case "workspace.create":
        return await host.port("workspaces").create?.({ path: String(params.path ?? "") });
      case "workspace.open": {
        const baseline = await dispatchHostPort(host, "workspaces", "workspace.follow", "follow", undefined);
        const stream = baseline as AsyncIterable<{ type?: string; value?: { items?: readonly Record<string, unknown>[] } }>;
        const first = await stream[Symbol.asyncIterator]().next();
        const workspaceId = String(params.workspaceId ?? "");
        const items = first.value?.value?.items as readonly Record<string, unknown>[] | undefined;
        const workspace = items?.find((item: Record<string, unknown>) => item.workspaceId === workspaceId);
        if (workspace === undefined) throw new Error("UNKNOWN_WORKSPACE");
        return workspace;
      }
      case "workspace.rename":
        return dispatchHostPort(host, "workspaces", "workspace.rename", "rename", params);
      case "workspace.remove":
        return dispatchHostPort(host, "workspaces", "workspace.delete", "delete", params);
      case "workspace.archiveSession":
        return dispatchHostPort(host, "workspaces", "workspace.archive-session", "archiveSession", params);
      case "session.list":
        return { items: await host.port("sessions").list?.() };
      case "session.create":
        return await host.port("sessions").create?.(params);
      case "session.open":
        return await host.port("sessions").open?.({ sessionId: String(params.sessionId ?? "") });
      case "session.search":
        return dispatchHostPort(host, "sessions", "session.search", "search", { query: String(params.query ?? "") });
      case "session.history":
        return dispatchHostPort(host, "sessions", "session.history", "history", params);
      case "session.resume":
        return dispatchHostPort(host, "sessions", "session.resume", "resume", params);
      case "session.rename":
        return dispatchHostPort(host, "sessions", "session.rename", "rename", params);
      case "session.restoreArchive":
        return dispatchHostPort(host, "sessions", "session.restore-archive", "restoreArchive", params);
      case "session.delete":
        return dispatchHostPort(host, "sessions", "session.delete", "delete", params);
      case "session.fork":
        return dispatchHostPort(host, "sessions", "session.fork", "fork", params);
      case "session.updateQueue":
        return dispatchHostPort(host, "sessions", "session.update-queue", "updateQueue", params);
      case "session.restart":
        return dispatchHostPort(host, "sessions", "session.restart", "restart", params);
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
      case "terminal.open":
        return dispatchHostPort(host, "terminals", "terminal.open", "open", params);
      case "terminal.read":
        return dispatchHostPort(host, "terminals", "terminal.read", "read", params);
      case "terminal.list":
        return { items: await dispatchHostPort(host, "terminals", "terminal.open", "list", params) };
      case "terminal.input":
        return dispatchHostPort(host, "terminals", "terminal.send", "send", {
          ...params,
          text: String(params.text ?? ""),
          submit: params.submit !== false,
        });
      case "terminal.resize":
        return dispatchHostPort(host, "terminals", "terminal.resize", "resize", params);
      case "terminal.interrupt":
        return dispatchHostPort(host, "terminals", "terminal.interrupt", "interrupt", params);
      case "terminal.close":
        return dispatchHostPort(host, "terminals", "terminal.close", "close", params);
      case "preset.catalog":
        return dispatchHostPort(host, "presets", "preset.catalog", "catalog", undefined);
      case "preset.select":
        return dispatchHostPort(host, "presets", "preset.select", "select", params);
      case "dynamic.host.define":
      case "dynamic.host.run":
      case "dynamic.host.update":
      case "dynamic.host.stop":
      case "dynamic.host.undefine":
      case "dynamic.host.inventory":
      case "dynamic.host.diagnostics": {
        const operation = request.method.slice("dynamic.host.".length);
        return dispatchHostPort(host, "dynamicRuntime", request.method, operation, params);
      }
      case "attachment.limits":
        return {
          maxBytes: 10 * 1024 * 1024,
          maxCount: 8,
          mediaTypes: ["image/png", "image/jpeg", "image/webp", "text/plain"],
          provenance: { source: "aio-dsh-host", schemaRevision: 1 },
        };
      case "context.summary": {
        const sessionId = String(params.sessionId ?? "");
        const value = await dispatchHostPort(host, "sessions", "session.snapshot", "snapshot", { sessionId }) as Parameters<typeof createAuthoritativeSnapshot>[0]["value"];
        const snapshot = createAuthoritativeSnapshot({
          contractHash: String(params.contractHash ?? ""),
          domainGenerationId: String(params.domainGenerationId ?? ""),
          sessionId,
          adapterId: host.adapterIdentity.adapterId,
          releaseCommit: host.adapterIdentity.releaseCommit,
          value,
        });
        return createContextSummary({
          workspaceId: String(params.workspaceId ?? "unknown-workspace"),
          sessionId,
          source: "dsh",
          cursor: snapshot.cursor,
          stale: false,
          facts: snapshot.durableFacts.map((fact) => ({ kind: fact.kind, text: JSON.stringify(fact.data) })),
          maxChars: Number(params.maxChars ?? 4000),
        });
      }
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

async function dispatchHostPort(
  host: DshHost,
  portName: HostPortName,
  capabilityId: string,
  method: string,
  input: unknown,
): Promise<unknown> {
  if (!host.availability(capabilityId).available) {
    throw new Error(`CAPABILITY_UNAVAILABLE: ${capabilityId}`);
  }
  const port = host.port(portName) as unknown as Record<string, unknown>;
  const operation = port[method];
  if (typeof operation !== "function") {
    throw new Error(`CAPABILITY_UNAVAILABLE: ${capabilityId}`);
  }
  return input === undefined
    ? Reflect.apply(operation, port, [])
    : Reflect.apply(operation, port, [input]);
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
