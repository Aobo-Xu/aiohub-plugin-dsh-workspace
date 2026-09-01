import type {
  AioLlmProfile,
  ProfileDiagnostic,
} from "../../runtime-facade/src/types.js";

export type MappedRoute = {
  adapterVersion: 1;
  routeId: string;
  protocol: "openai-chat-completions";
  baseUrl: string;
  model: string;
  headers: Readonly<Record<string, string>>;
  parameters: Readonly<Record<string, unknown>>;
  credentialRef: `aio-profile:${string}`;
};

export interface AioProfileAdapterV1 {
  validate(profile: AioLlmProfile): readonly ProfileDiagnostic[];
  map(profile: AioLlmProfile): MappedRoute;
}

type ProviderChatInput = {
  messages: readonly Record<string, unknown>[];
  signal?: AbortSignal;
  baseUrlOverride?: string;
};

type ProviderChatResult = {
  content: string;
  raw: unknown;
};

type ProviderOptions = {
  resolveCredential(ref: string): Promise<string | { value?: string } | undefined>;
  fetch?: typeof fetch;
};

const TOP_LEVEL_FIELDS = new Set([
  "id",
  "protocol",
  "baseUrl",
  "model",
  "apiKey",
  "headers",
  "options",
]);

const ALLOWED_PARAMETERS = new Set([
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "max_completion_tokens",
  "max_tokens",
  "n",
  "parallel_tool_calls",
  "presence_penalty",
  "response_format",
  "seed",
  "stop",
  "stream",
  "temperature",
  "tool_choice",
  "tools",
  "top_logprobs",
  "top_p",
  "user",
]);

export function createProfileAdapter(): AioProfileAdapterV1 {
  return {
    validate,
    map(profile) {
      const diagnostics = validate(profile);
      if (diagnostics.length > 0) {
        const unsupported = diagnostics.find(
          (diagnostic) => diagnostic.code === "UNSUPPORTED_PROFILE_FIELDS",
        );
        throw new ProfileAdapterError(
          unsupported?.code ?? "INVALID_PROFILE",
          unsupported?.field,
        );
      }

      return {
        adapterVersion: 1,
        routeId: credentialRef(profile),
        protocol: "openai-chat-completions",
        baseUrl: profile.baseUrl,
        model: profile.model,
        headers: Object.freeze({ ...(profile.headers ?? {}) }),
        parameters: Object.freeze({ ...(profile.options ?? {}) }),
        credentialRef: credentialRef(profile),
      };
    },
  };
}

export function createOpenAiCompatibleProvider(
  route: MappedRoute,
  options: ProviderOptions,
) {
  const fetchImpl = options.fetch ?? fetch;

  return {
    async chat(input: ProviderChatInput): Promise<ProviderChatResult> {
      input.signal?.throwIfAborted();
      const credential = await options.resolveCredential(route.credentialRef);
      const apiKey =
        typeof credential === "string" ? credential : credential?.value;
      if (!apiKey) {
        throw new ProfileAdapterError("CREDENTIAL_NOT_CONFIGURED");
      }

      const response = await fetchImpl(
        `${(input.baseUrlOverride ?? route.baseUrl).replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          signal: input.signal,
          headers: {
            ...route.headers,
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...route.parameters,
            model: route.model,
            messages: input.messages,
          }),
        },
      );

      const raw = await response.json().catch(() => undefined);
      if (!response.ok) {
        throw new ProfileAdapterError("PROVIDER_REQUEST_FAILED");
      }

      return {
        content: extractContent(raw),
        raw,
      };
    },
  };
}

class ProfileAdapterError extends Error {
  public readonly code: string;
  public readonly field?: string;

  public constructor(code: string, field?: string) {
    super(field ? `${code}: ${field}` : code);
    this.name = "ProfileAdapterError";
    this.code = code;
    this.field = field;
  }
}

function validate(profile: AioLlmProfile): readonly ProfileDiagnostic[] {
  const diagnostics: ProfileDiagnostic[] = [];
  for (const field of Object.keys(profile as Record<string, unknown>)) {
    if (!TOP_LEVEL_FIELDS.has(field)) {
      diagnostics.push(unsupported(field));
    }
  }

  if (profile.protocol !== "openai-compatible" && profile.protocol !== "vcp") {
    diagnostics.push({
      code: "UNSUPPORTED_PROFILE_PROTOCOL",
      field: "protocol",
      message: "Profile protocol is not supported.",
    });
  }

  if (!isHttpUrl(profile.baseUrl)) {
    diagnostics.push(invalid("baseUrl"));
  }
  if (typeof profile.model !== "string" || profile.model.length === 0) {
    diagnostics.push(invalid("model"));
  }
  if (profile.headers !== undefined && !isStringRecord(profile.headers)) {
    diagnostics.push(invalid("headers"));
  }

  for (const key of Object.keys(profile.options ?? {})) {
    if (!ALLOWED_PARAMETERS.has(key)) {
      diagnostics.push(unsupported(`options.${key}`));
    }
  }
  return diagnostics;
}

function credentialRef(profile: AioLlmProfile): `aio-profile:${string}` {
  return `aio-profile:${profile.id}`;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function unsupported(field: string): ProfileDiagnostic {
  return {
    code: "UNSUPPORTED_PROFILE_FIELDS",
    field,
    message: `Profile field is not supported: ${field}`,
  };
}

function invalid(field: string): ProfileDiagnostic {
  return {
    code: "INVALID_PROFILE",
    field,
    message: `Profile field is invalid: ${field}`,
  };
}

function extractContent(raw: unknown): string {
  if (
    typeof raw === "object" &&
    raw !== null &&
    Array.isArray((raw as { choices?: unknown }).choices)
  ) {
    const first = (raw as { choices: unknown[] }).choices[0];
    if (typeof first === "object" && first !== null) {
      const message = (first as { message?: unknown }).message;
      if (typeof message === "object" && message !== null) {
        const content = (message as { content?: unknown }).content;
        if (typeof content === "string") return content;
      }
    }
  }
  return "";
}
