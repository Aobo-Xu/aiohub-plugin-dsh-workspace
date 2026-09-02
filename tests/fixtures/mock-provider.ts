import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

export type MockProviderRequest = {
  url: URL;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
};

export type MockProviderOptions = {
  responses?: readonly string[];
};

export type MockProvider = {
  server: Server;
  url: string;
  requests: readonly MockProviderRequest[];
  close(): Promise<void>;
};

export async function createMockProvider(
  options: MockProviderOptions = {}
): Promise<MockProvider> {
  const requests: MockProviderRequest[] = [];
  const responses = [...(options.responses ?? ["mock-complete"])];
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

      const content = responses.length > 1 ? responses.shift() : responses[0];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: { content, role: "assistant" },
              finish_reason: "stop",
            },
          ],
        })
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
