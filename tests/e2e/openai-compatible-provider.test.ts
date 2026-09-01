import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AioLlmProfile } from "../../packages/runtime-facade/src/types.js";
import { createProfileAdapter } from "../../packages/dsh-bridge/src/profile-adapter.js";
import {
  createCredentialProvider,
  toDshCredentialRef,
} from "../../packages/dsh-bridge/src/credential-provider.js";
import { createOpenAiCompatibleProvider } from "../../packages/dsh-bridge/src/profile-adapter.js";

const profile: AioLlmProfile = {
  id: "vcp-local",
  protocol: "openai-compatible",
  baseUrl: "http://127.0.0.1:6005/v1",
  model: "deepseek-chat",
  apiKey: "e2e-secret",
  headers: { "X-Tenant": "aio" },
  options: { temperature: 0.2, max_tokens: 1024 },
};

const servers: Server[] = [];

afterEach(async () => {
  const openServers = servers.splice(0);
  await Promise.all(
    openServers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function listen(): Promise<{
  server: Server;
  url: string;
  requests: {
    url: URL;
    headers: Record<string, string | string[] | undefined>;
    body: Record<string, unknown>;
  }[];
}> {
  const requests: {
    url: URL;
    headers: Record<string, string | string[] | undefined>;
    body: Record<string, unknown>;
  }[] = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    request.on("end", () => {
      requests.push({
        url: new URL(request.url ?? "/", "http://127.0.0.1"),
        headers: request.headers,
        body: JSON.parse(text || "{}") as Record<string, unknown>,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not return a TCP address");
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
  };
}

describe("OpenAI-compatible provider", () => {
  it("sends a mapped route and current key without leaking the key into route data", async () => {
    const target = await listen();
    const adapter = createProfileAdapter();
    const mapped = adapter.map({ ...profile, baseUrl: target.url });
    let key = "first-secret";
    const provider = createOpenAiCompatibleProvider(mapped, {
      resolveCredential: async () => key,
    });

    const first = await provider.chat({
      messages: [{ role: "user", content: "Use {{Nova}} literally." }],
    });
    key = "second-secret";
    const second = await provider.chat({
      messages: [{ role: "user", content: "Use {{Nova}} literally." }],
    });

    expect(first.content).toBe("done");
    expect(second.content).toBe("done");
    expect(target.requests).toHaveLength(2);
    expect(target.requests[0]?.url.pathname).toBe("/v1/chat/completions");
    expect(target.requests[1]?.url.pathname).toBe("/v1/chat/completions");
    expect(target.requests[0]?.headers.authorization).toBe("Bearer first-secret");
    expect(target.requests[1]?.headers.authorization).toBe("Bearer second-secret");
    expect(JSON.stringify(mapped)).not.toContain("e2e-secret");
    expect(JSON.stringify(first)).not.toContain("secret");
  });

  it("passes stream and tool parameters in the wire request", async () => {
    const target = await listen();
    const adapter = createProfileAdapter();
    const mapped = adapter.map({
      ...profile,
      baseUrl: target.url,
      options: {
        ...profile.options,
        stream: true,
        tools: [{ type: "function", function: { name: "lookup" } }],
        tool_choice: "auto",
      },
    });
    const provider = createOpenAiCompatibleProvider(mapped, {
      resolveCredential: async () => "tool-secret",
    });

    await provider.chat({
      messages: [{ role: "user", content: "lookup" }],
    });

    expect(target.requests[0]?.body).toEqual(
      expect.objectContaining({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "lookup" }],
        temperature: 0.2,
        max_tokens: 1024,
        stream: true,
        tools: [{ type: "function", function: { name: "lookup" } }],
        tool_choice: "auto",
      }),
    );
    expect(JSON.stringify(target.requests[0]?.body)).not.toContain("tool-secret");
  });

  it("uses the credential mirror at the provider boundary", async () => {
    const adapter = createProfileAdapter();
    const mapped = adapter.map(profile);
    let resolvedRef = "";
    const provider = createCredentialProvider({
      mirror: {
        replace: async () => undefined,
        resolve: async (ref) => {
          resolvedRef = ref;
          return {
            value: "mirrored-secret",
            source: "file",
            ref,
          };
        },
        describe: async (ref) => ({
          configured: true,
          source: "file",
          writable: true,
          ref,
        }),
      },
    });
    const model = createOpenAiCompatibleProvider(mapped, {
      resolveCredential: provider.resolve,
      fetch: async () =>
        new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    await model.chat({
      messages: [{ role: "user", content: "hello" }],
      baseUrlOverride: "http://127.0.0.1:1/v1",
    });

    expect(resolvedRef).toBe(toDshCredentialRef(mapped.credentialRef));
  });

  it("reports provider errors without the key", async () => {
    const adapter = createProfileAdapter();
    const mapped = adapter.map(profile);
    const provider = createOpenAiCompatibleProvider(mapped, {
      resolveCredential: async () => "error-secret",
      fetch: async () =>
        new Response(JSON.stringify({ error: "upstream failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    });

    let failure: unknown;
    try {
      await provider.chat({
        messages: [{ role: "user", content: "hello" }],
        baseUrlOverride: "http://127.0.0.1:1/v1",
      });
    } catch (error) {
      failure = error;
    }

    expect((failure as { code?: string }).code).toBe("PROVIDER_REQUEST_FAILED");
    expect(String(failure)).not.toContain("error-secret");
  });

  it("propagates cancellation before a request is sent", async () => {
    const adapter = createProfileAdapter();
    const mapped = adapter.map(profile);
    let called = false;
    const provider = createOpenAiCompatibleProvider(mapped, {
      resolveCredential: async () => "cancel-secret",
      fetch: async () => {
        called = true;
        throw new Error("fetch should not run");
      },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.chat({
        messages: [{ role: "user", content: "hello" }],
        signal: controller.signal,
        baseUrlOverride: "http://127.0.0.1:1/v1",
      }),
    ).rejects.toThrow(/aborted/i);
    expect(called).toBe(false);
  });
});
