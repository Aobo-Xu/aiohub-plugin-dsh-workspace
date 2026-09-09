import { reactive } from "vue";

/**
 * The only state the workstation is allowed to persist: bounded UI
 * preferences. Sessions, interactions, drafts, attachment contents, Side
 * Chats and Host events must never appear here.
 */
export const PERSISTED_PREFERENCE_KEYS = [
  "paneWidths",
  "collapsedSections",
  "locale",
  "closeWarningSuppressed",
] as const;

export type WorkstationUiPreferences = {
  paneWidths: Record<string, number>;
  collapsedSections: Record<string, boolean>;
  locale: string | undefined;
  closeWarningSuppressed: boolean;
};

export const PREFERENCE_STORAGE_KEY = "workstationUi";

export type PluginConfigLike = {
  getValue<T>(pluginId: string, key: string): Promise<T | undefined>;
  setValue(pluginId: string, key: string, value: unknown): Promise<void>;
};

export type UiStoreOptions = {
  pluginId: string;
  config?: PluginConfigLike;
  debounceMs?: number;
};

export function createUiStore(options: UiStoreOptions) {
  const debounceMs = options.debounceMs ?? 300;
  const preferences = reactive<WorkstationUiPreferences>({
    paneWidths: {},
    collapsedSections: {},
    locale: undefined,
    closeWarningSuppressed: false,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();

  async function configService(): Promise<PluginConfigLike> {
    if (options.config !== undefined) {
      return options.config;
    }
    const { pluginConfigService } = await import("aiohub-sdk");
    return pluginConfigService as PluginConfigLike;
  }

  function snapshotPreferences(): WorkstationUiPreferences {
    return {
      paneWidths: { ...preferences.paneWidths },
      collapsedSections: { ...preferences.collapsedSections },
      locale: preferences.locale,
      closeWarningSuppressed: preferences.closeWarningSuppressed,
    };
  }

  function schedulePersist(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      pending = persist();
    }, debounceMs);
  }

  async function persist(): Promise<void> {
    const config = await configService();
    await config.setValue(options.pluginId, PREFERENCE_STORAGE_KEY, snapshotPreferences());
  }

  /** Flushes any debounced write; resolves after persistence completed. */
  async function flush(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      pending = persist();
    }
    await pending;
  }

  async function load(): Promise<void> {
    const config = await configService();
    const stored = await config.getValue<Partial<WorkstationUiPreferences>>(
      options.pluginId,
      PREFERENCE_STORAGE_KEY,
    );
    if (stored === undefined || typeof stored !== "object") {
      return;
    }
    // Filter to the allowlist: unknown legacy or foreign keys are dropped.
    preferences.paneWidths = isPlainRecord(stored.paneWidths) ? { ...stored.paneWidths } : {};
    preferences.collapsedSections = isPlainRecord(stored.collapsedSections)
      ? { ...stored.collapsedSections }
      : {};
    preferences.locale = typeof stored.locale === "string" ? stored.locale : undefined;
    preferences.closeWarningSuppressed = stored.closeWarningSuppressed === true;
  }

  function setPaneWidth(pane: string, width: number): void {
    preferences.paneWidths[pane] = width;
    schedulePersist();
  }

  function toggleSection(section: string, collapsed: boolean): void {
    preferences.collapsedSections[section] = collapsed;
    schedulePersist();
  }

  function setLocale(locale: string | undefined): void {
    preferences.locale = locale;
    schedulePersist();
  }

  function setCloseWarningSuppressed(suppressed: boolean): void {
    preferences.closeWarningSuppressed = suppressed;
    schedulePersist();
  }

  return {
    preferences,
    load,
    flush,
    setPaneWidth,
    toggleSection,
    setLocale,
    setCloseWarningSuppressed,
  };
}

function isPlainRecord(value: unknown): value is Record<string, never> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
