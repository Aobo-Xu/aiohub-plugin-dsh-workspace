/**
 * Local typings for the AIO host import-map modules. The runtime values are
 * supplied by window-backed shims; only the public surface the workstation
 * actually consumes is declared here.
 */
declare module "aiohub-sdk" {
  import type { Ref } from "vue";
  export const pluginManager: {
    getActivePlugin(pluginId: string): unknown;
  };
  export const pluginConfigService: {
    getValue<T>(pluginId: string, key: string): Promise<T | undefined>;
    setValue(pluginId: string, key: string, value: unknown): Promise<void>;
  };
  export function useLlmProfiles(): {
    enabledProfiles: Ref<readonly unknown[]>;
  };
}

declare module "aiohub-ui" {
  import type { Component } from "vue";
  export const LlmModelSelector: Component;
  export const BaseDialog: Component;
  export const RichCodeEditor: Component;
  export const RichTextRenderer: Component;
  export const DraggablePanel: Component;
  export const DynamicIcon: Component;
  const ui: Record<string, Component>;
  export default ui;
}
