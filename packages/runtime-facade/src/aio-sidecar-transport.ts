import type { SidecarTransport } from "./types.js";

export type AioSidecarSpawnInput = {
  executablePath: string;
  args: readonly string[];
  installPath?: string;
};

export type AioSidecarCommand = {
  pluginId: string;
  method: string;
  params: unknown;
};

export type AioSidecarResidentEvent = {
  plugin_id: string;
  generation_id?: string;
  event_type: string;
  event_name: string | null;
  data: string;
};

export interface AioSidecarHost {
  spawnResident(input: AioSidecarSpawnInput & { pluginId: string }): Promise<string>;
  sendCommand(input: AioSidecarCommand): Promise<string>;
  killResident(input: { pluginId: string }): Promise<void>;
  onResidentEvent(
    listener: (event: AioSidecarResidentEvent) => void
  ): () => void;
}

export class AioSidecarTransport implements SidecarTransport {
  public constructor(
    private readonly host: AioSidecarHost,
    private readonly pluginId: string
  ) {}

  public spawn(input: AioSidecarSpawnInput): Promise<string> {
    return this.host.spawnResident({ ...input, pluginId: this.pluginId });
  }

  public async request<T>(method: string, params: unknown): Promise<T> {
    const response = await this.host.sendCommand({
      pluginId: this.pluginId,
      method,
      params,
    });
    const parsed = parseSidecarResponse(response, this.pluginId, method);

    return parsed as T;
  }

  public onEvent(callback: (value: unknown) => void): () => void {
    return this.host.onResidentEvent((event) => {
      if (event.plugin_id !== this.pluginId || event.event_type !== "event") {
        return;
      }

      callback(parseSidecarEvent(event, this.pluginId));
    });
  }

  public kill(): Promise<void> {
    return this.host.killResident({ pluginId: this.pluginId });
  }
}

function parseSidecarResponse(
  response: string,
  pluginId: string,
  method: string
): unknown {
  let parsed: unknown;

  try {
    parsed = JSON.parse(response);
  } catch {
    throw new Error(
      `AIO Sidecar ${pluginId}.${method} returned a non-JSON response.`
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(`AIO Sidecar ${pluginId}.${method} returned an invalid response.`);
  }
  if (parsed.type === "error") {
    throw new Error(
      `AIO Sidecar ${pluginId}.${method} failed: ${formatError(parsed.data)}`
    );
  }
  if (parsed.type !== "result" || !("data" in parsed)) {
    throw new Error(
      `AIO Sidecar ${pluginId}.${method} returned an unsupported response envelope.`
    );
  }

  return parsed.data;
}

function parseSidecarEvent(
  event: AioSidecarResidentEvent,
  pluginId: string
): unknown {
  try {
    const parsed: unknown = JSON.parse(event.data);
    if (isRecord(parsed) && parsed.type === "event" && "data" in parsed) {
      return parsed.data;
    }
  } catch {
    // AIO exposes the raw JSONL line; reject malformed event payloads clearly.
  }

  throw new Error(
    `AIO Sidecar ${pluginId} emitted an invalid resident event${
      event.event_name ? ` (${event.event_name})` : ""
    }.`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatError(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
