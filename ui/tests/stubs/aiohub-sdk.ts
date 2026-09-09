/**
 * Test stub for the aiohub-sdk import-map module. Mutable singletons let
 * tests script host behavior without touching production imports.
 */
import { ref } from "vue";

export const stubProfiles = ref<readonly unknown[]>([]);
export const dialogSelections = ref<string[]>([]);
export const configWrites: { pluginId: string; key: string; value: unknown }[] = [];

export const pluginManager = {
  getActivePlugin(_pluginId: string): unknown {
    return undefined;
  },
};

export const pluginConfigService = {
  async getValue<T>(_pluginId: string, _key: string): Promise<T | undefined> {
    return undefined;
  },
  async setValue(pluginId: string, key: string, value: unknown): Promise<void> {
    configWrites.push({ pluginId, key, value });
  },
};

export const customMessage = {
  info: (_message: string) => {},
  success: (_message: string) => {},
  warning: (_message: string) => {},
  error: (_message: string) => {},
};

export function useLlmProfiles() {
  return { enabledProfiles: stubProfiles };
}

export async function openDialog(): Promise<string[]> {
  return [...dialogSelections.value];
}

export function resetSdkStubs(): void {
  stubProfiles.value = [];
  dialogSelections.value = [];
  configWrites.length = 0;
}
