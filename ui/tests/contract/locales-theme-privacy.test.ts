import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../../src/locales/en";
import { zhCN } from "../../src/locales/zh-CN";
import { createLocaleAdapter } from "../../src/locales/index";
import { maskSensitiveText } from "../../src/shared/masking";

function collectKeys(dictionary: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(dictionary).flatMap(([key, value]) => {
    const path = prefix.length > 0 ? `${prefix}.${key}` : key;
    return typeof value === "object" && value !== null ? collectKeys(value as Record<string, unknown>, path) : [path];
  });
}

function vueFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...vueFiles(full));
    else if (entry.endsWith(".vue")) out.push(full);
  }
  return out;
}

describe("locales", () => {
  it("keeps zh-CN and en key parity", () => {
    expect(collectKeys(zhCN).sort()).toEqual(collectKeys(en).sort());
  });

  it("passes runtime labels through and falls back to stable ids", () => {
    const adapter = createLocaleAdapter({ hostLocale: "zh-CN" });
    expect(adapter.locale).toBe("zh-CN");
    expect(adapter.t("composer.send")).toBe("发送");
    // Host-provided runtime labels are never translated or rewritten.
    expect(adapter.passthroughLabel("Future X (runtime label)")).toBe("Future X (runtime label)");
    // Unknown keys fall back to the stable id, never empty or fabricated.
    expect(adapter.t("not.a.real.key")).toBe("not.a.real.key");
  });

  it("defaults from host locale, then stored preference, then browser", () => {
    expect(createLocaleAdapter({ hostLocale: "en", storedPreference: "zh-CN" }).locale).toBe("en");
    expect(createLocaleAdapter({ storedPreference: "zh-CN", browserLocale: "en" }).locale).toBe("zh-CN");
    expect(createLocaleAdapter({ browserLocale: "zh-CN" }).locale).toBe("zh-CN");
    expect(createLocaleAdapter({ browserLocale: "fr" }).locale).toBe("en");
  });
});

describe("theme tokens", () => {
  it("uses no hard-coded surface colors outside var() fallbacks", () => {
    const offenders: string[] = [];
    for (const file of vueFiles(join(import.meta.dirname, "..", "..", "src"))) {
      const source = readFileSync(file, "utf8");
      const style = source.split(/<style[^>]*>/).slice(1).join("\n");
      // A hex color directly assigned to a property (not inside a var fallback)
      // is a hard-coded surface color.
      if (/:\s*#[0-9a-fA-F]{3,8}/.test(style)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("declares reduced-motion behavior in the shell", () => {
    const shell = readFileSync(join(import.meta.dirname, "..", "..", "src", "shell", "WorkstationShell.vue"), "utf8");
    expect(shell).toContain("prefers-reduced-motion");
  });
});

describe("privacy masking", () => {
  it("masks credential-like content before any sink", () => {
    const masked = maskSensitiveText('apiKey = "sk-live-999"; token: abc123; note = "safe"');
    expect(masked).not.toContain("sk-live-999");
    expect(masked).not.toContain("abc123");
    expect(masked).toContain("safe");
    expect(maskSensitiveText("plain text")).toBe("plain text");
  });
});
