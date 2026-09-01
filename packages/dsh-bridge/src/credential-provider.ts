import type { AioLlmProfile } from "../../runtime-facade/src/types.js";

type MirrorEntry = Readonly<{
  ref: string;
  credentialRef: `aio-profile:${string}`;
}>;

type MirrorCredential = Readonly<{
  value?: string;
  source?: string;
  ref?: string;
}>;

type MirrorCredentialInfo = Readonly<{
  configured: boolean;
  source?: string;
  writable: boolean;
  ref?: string;
}>;

type CredentialMirror = {
  replace(entries: readonly MirrorEntry[]): Promise<void>;
  resolve(ref: string): Promise<MirrorCredential | undefined>;
  describe(ref: string): Promise<MirrorCredentialInfo>;
};

type CredentialProviderOptions = {
  mirror: CredentialMirror;
};

export function createCredentialProvider(options: CredentialProviderOptions) {
  return {
    async bindProfile(profile: AioLlmProfile): Promise<void> {
      await options.mirror.replace([
        {
          ref: toDshCredentialRef(toAioCredentialRef(profile.id)),
          credentialRef: toAioCredentialRef(profile.id),
        },
      ]);
    },

    async clear(): Promise<void> {
      await options.mirror.replace([]);
    },

    async resolve(ref: `aio-profile:${string}`): Promise<MirrorCredential | undefined> {
      return options.mirror.resolve(toDshCredentialRef(ref));
    },

    async describe(ref: `aio-profile:${string}`): Promise<MirrorCredentialInfo> {
      return options.mirror.describe(toDshCredentialRef(ref));
    },
  };
}

export function toDshCredentialRef(ref: `aio-profile:${string}` | string): string {
  if (!ref.startsWith("aio-profile:")) {
    throw new Error("credential reference must start with aio-profile:");
  }
  const encoded = Array.from(
    new TextEncoder().encode(ref.slice("aio-profile:".length)),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `AIO_PROFILE_${encoded}`;
}

function toAioCredentialRef(id: string): `aio-profile:${string}` {
  return `aio-profile:${id}`;
}
