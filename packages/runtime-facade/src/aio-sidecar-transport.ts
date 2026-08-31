import type { SidecarTransport } from "./types.js";

export const DSH_RUNTIME_EVENT_NAME = "dsh-runtime-event";

export interface AioPluginProxy {
  disable(): Promise<void>;
  onSidecarEvent?: (
    eventName: string,
    callback: (data: unknown) => void
  ) => () => void;
  [method: string]: unknown;
}

export class AioSidecarTransport implements SidecarTransport {
  public constructor(private readonly plugin: AioPluginProxy) {}

  public async request<T>(method: string, params: unknown): Promise<T> {
    const candidate = this.plugin[method];
    if (typeof candidate !== "function") {
      throw new Error(`AIO PluginProxy does not expose Sidecar method ${method}.`);
    }

    return (await Reflect.apply(candidate, this.plugin, [params])) as T;
  }

  public onEvent(callback: (value: unknown) => void): () => void {
    const subscribe = this.plugin.onSidecarEvent;
    if (typeof subscribe !== "function") {
      throw new Error("AIO PluginProxy does not support resident Sidecar events.");
    }

    return Reflect.apply(subscribe, this.plugin, [DSH_RUNTIME_EVENT_NAME, callback]);
  }

  public kill(): Promise<void> {
    return this.plugin.disable();
  }
}
