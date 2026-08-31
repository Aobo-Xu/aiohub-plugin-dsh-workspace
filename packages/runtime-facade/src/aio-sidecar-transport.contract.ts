import { AioSidecarTransport } from "./aio-sidecar-transport.js";

interface PublicPluginProxyFixture {
  disable(): Promise<void>;
  onSidecarEvent?: (
    eventName: string,
    callback: (data: unknown) => void
  ) => () => void;
}

interface PublicPluginProxyWithMethod extends PublicPluginProxyFixture {
  initialize(params: unknown): Promise<unknown>;
}

const publicPluginProxyFixture: PublicPluginProxyWithMethod = {
  initialize: async (_params: unknown) => ({ ready: true }),
  disable: async () => undefined,
  onSidecarEvent: (_eventName: string, _callback: (data: unknown) => void) =>
    () => undefined,
};

const pluginProxyMustRemainStructurallyAssignable = new AioSidecarTransport(
  publicPluginProxyFixture
);

void pluginProxyMustRemainStructurallyAssignable;
