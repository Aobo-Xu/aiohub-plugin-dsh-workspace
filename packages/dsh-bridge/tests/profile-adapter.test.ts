import { describe, expect, it } from "vitest";
import type { AioLlmProfile } from "../../runtime-facade/src/types.js";
import { createProfileAdapter } from "../src/profile-adapter.js";
import {
  createCredentialProvider,
  toDshCredentialRef,
} from "../src/credential-provider.js";

const profile: AioLlmProfile = {
  id: "profile/one",
  protocol: "openai-compatible",
  baseUrl: "http://127.0.0.1:6005/v1",
  model: "deepseek-chat",
  apiKey: "profile-secret",
  headers: { "X-Tenant": "aio" },
  options: {
    temperature: 0.2,
    max_tokens: 1024,
    top_p: 0.8,
    frequency_penalty: 0.1,
    presence_penalty: 0.3,
    stop: ["END"],
  },
};

describe("AIO profile adapter", () => {
  it("maps a VCP/OpenAI-compatible profile without embedding its key", () => {
    const adapter = createProfileAdapter();
    const mapped = adapter.map(profile);

    expect(mapped).toEqual({
      adapterVersion: 1,
      routeId: "aio-profile:profile/one",
      protocol: "openai-chat-completions",
      baseUrl: "http://127.0.0.1:6005/v1",
      model: "deepseek-chat",
      headers: { "X-Tenant": "aio" },
      parameters: profile.options,
      credentialRef: "aio-profile:profile/one",
    });
    expect(JSON.stringify(mapped)).not.toContain("profile-secret");
  });

  it("keeps route identity stable while the key rotates", () => {
    const adapter = createProfileAdapter();
    const first = adapter.map(profile);
    const second = adapter.map({ ...profile, apiKey: "profile-secret-2" });

    expect(second.routeId).toBe(first.routeId);
    expect(second.credentialRef).toBe(first.credentialRef);
    expect(JSON.stringify(second)).not.toContain("profile-secret-2");
  });

  it("returns field-level diagnostics without secret values", () => {
    const adapter = createProfileAdapter();
    const diagnostics = adapter.validate({
      ...profile,
      protocol: "anthropic",
      options: { unsupportedWireFlag: true, temperature: 0.1 },
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNSUPPORTED_PROFILE_PROTOCOL",
          field: "protocol",
        }),
        expect.objectContaining({
          code: "UNSUPPORTED_PROFILE_FIELDS",
          field: "options.unsupportedWireFlag",
        }),
      ]),
    );
    expect(JSON.stringify(diagnostics)).not.toContain("profile-secret");
  });

  it("fails closed on unsupported or invalid profile data", () => {
    const adapter = createProfileAdapter();

    for (const override of [
      { protocol: "claude" },
      { baseUrl: "ftp://example.invalid" },
      { headers: { "X-Tenant": 7 } },
      { options: { unsupportedWireFlag: true } },
    ] as Partial<AioLlmProfile>[]) {
      let failure: unknown;
      try {
        adapter.map({ ...profile, ...override });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as { code?: string }).code).toBe(
        override.options ? "UNSUPPORTED_PROFILE_FIELDS" : "INVALID_PROFILE",
      );
      expect(String(failure)).not.toContain("profile-secret");
    }
  });

  it("rejects unknown top-level profile fields", () => {
    const adapter = createProfileAdapter();
    const rawProfile = {
      ...profile,
      customEndpoint: "https://example.invalid/v1/chat",
    } as unknown as AioLlmProfile;

    expect(adapter.validate(rawProfile)).toEqual([
      expect.objectContaining({
        code: "UNSUPPORTED_PROFILE_FIELDS",
        field: "customEndpoint",
      }),
    ]);
  });
});

describe("controlled credential mirror", () => {
  it("translates opaque refs to stable DSH-safe refs", () => {
    const ref = toDshCredentialRef("aio-profile:profile/one");

    expect(ref).toMatch(/^AIO_PROFILE_[A-Za-z0-9_]+$/);
    expect(toDshCredentialRef("aio-profile:profile/one")).toBe(ref);
    expect(toDshCredentialRef("aio-profile:profile/two")).not.toBe(ref);
    expect(() => toDshCredentialRef("profile/one")).toThrow(
      /credential reference must start with aio-profile:/,
    );
  });

  it("replaces only the current route and resolves per operation", async () => {
    const operations: string[] = [];
    let current = "first-secret";
    const provider = createCredentialProvider({
      mirror: {
        replace: async (entries) => {
          operations.push(JSON.stringify(entries));
        },
        resolve: async (ref) => ({
          value: current,
          source: "aio-profile",
          ref,
        }),
        describe: async (ref) => ({
          configured: true,
          source: "aio-profile",
          writable: true,
          ref,
        }),
      },
    });

    await provider.bindProfile(profile);
    await expect(provider.resolve("aio-profile:profile/one")).resolves.toEqual({
      value: "first-secret",
      source: "aio-profile",
      ref: toDshCredentialRef("aio-profile:profile/one"),
    });

    current = "second-secret";
    await provider.bindProfile({ ...profile, apiKey: "second-secret" });
    await expect(provider.resolve("aio-profile:profile/one")).resolves.toEqual({
      value: "second-secret",
      source: "aio-profile",
      ref: toDshCredentialRef("aio-profile:profile/one"),
    });

    expect(operations).toHaveLength(2);
    expect(operations[0]).not.toContain("first-secret");
    expect(operations[1]).not.toContain("second-secret");
  });

  it("clears stale references on unbind or clear", async () => {
    const operations: string[] = [];
    const provider = createCredentialProvider({
      mirror: {
        replace: async (entries) => {
          operations.push(JSON.stringify(entries));
        },
        resolve: async () => undefined,
        describe: async () => ({ configured: false, writable: true }),
      },
    });

    await provider.bindProfile(profile);
    await provider.clear();
    await expect(provider.describe("aio-profile:profile/one")).resolves.toEqual({
      configured: false,
      writable: true,
    });

    expect(operations).toHaveLength(2);
    expect(operations[1]).toBe("[]");
  });
});
