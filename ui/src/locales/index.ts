import { en, type WorkstationStrings } from "./en";
import { zhCN } from "./zh-CN";

export type LocaleId = "zh-CN" | "en";

const DICTIONARIES: Readonly<Record<LocaleId, WorkstationStrings>> = { en, "zh-CN": zhCN };

function isLocaleId(value: string | undefined): value is LocaleId {
  return value !== undefined && value in DICTIONARIES;
}

export type LocaleAdapterOptions = {
  /** Public host locale when AIO advertises one; highest priority. */
  hostLocale?: string;
  /** Bounded plugin-local preference. */
  storedPreference?: string;
  /** Browser/OS locale as the last resort. */
  browserLocale?: string;
};

export type LocaleAdapter = {
  locale: LocaleId;
  setLocale(locale: LocaleId): void;
  t(key: string, params?: Record<string, string | number>): string;
  /** Host-provided runtime labels are passed through unchanged. */
  passthroughLabel(value: string): string;
};

/**
 * Typed bilingual strings without an AIO-wide i18n dependency. Unknown keys
 * fall back to the stable key id, never to empty or fabricated text.
 */
export function createLocaleAdapter(options: LocaleAdapterOptions = {}): LocaleAdapter {
  let locale: LocaleId = isLocaleId(options.hostLocale)
    ? options.hostLocale
    : isLocaleId(options.storedPreference)
      ? options.storedPreference
      : isLocaleId(options.browserLocale)
        ? options.browserLocale
        : "en";

  function t(key: string, params?: Record<string, string | number>): string {
    let current: unknown = DICTIONARIES[locale];
    for (const segment of key.split(".")) {
      if (typeof current !== "object" || current === null) {
        return key;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    if (typeof current !== "string") {
      return key;
    }
    if (params === undefined) {
      return current;
    }
    return current.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match,
    );
  }

  return {
    get locale() {
      return locale;
    },
    setLocale(next: LocaleId) {
      locale = next;
    },
    t,
    passthroughLabel: (value: string) => value,
  };
}
