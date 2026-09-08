import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "dist/probe-release-host");
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const archive = resolve(process.argv[3] ?? "dist/dsh-coding-workspace-0.1.0-win32-x64.zip");
const tar = Bun.spawn(["tar", "-xf", archive, "-C", root], { stdout: "ignore", stderr: "pipe" });
if (await tar.exited !== 0) throw new Error("failed to extract release ZIP");

const requests: unknown[] = [];
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk.toString(); });
  request.on("end", () => {
    requests.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolvePromise);
});
const address = server.address();
if (address === null || typeof address === "string") throw new Error("provider address unavailable");
const baseUrl = `http://127.0.0.1:${address.port}`;
const child = spawn(join(root, "bin", "win32-x64", "aio-dsh-supervisor.exe"), [], {
  cwd: root,
  stdio: ["pipe", "pipe", "inherit"],
  windowsHide: true,
  env: {
    ...process.env,
    AIO_DSH_HOST_DIAGNOSTICS: "1",
    AIO_DSH_SUPERVISOR_PLUGIN_DATA_DIR: join(root, "app-data"),
  },
});
const lines = createInterface({ input: child.stdout });
const pending = new Map<number, (value: any) => void>();
lines.on("line", (line) => {
  const value = JSON.parse(line);
  const resolvePending = pending.get(value.id);
  if (resolvePending !== undefined) {
    pending.delete(value.id);
    resolvePending(value);
  } else {
    console.log("NOTIFICATION", line);
  }
});
let nextId = 1;
function send(method: string, params: Record<string, unknown>): Promise<any> {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return new Promise((resolvePromise) => pending.set(id, resolvePromise));
}
const initialized = await send("initialize", {
  hostContext: { apiVersion: 3, sidecarProtocolVersion: 3 },
  provider: { baseUrl, apiKey: "probe-secret" },
});
console.log("INITIALIZE", JSON.stringify(initialized));
if (initialized.type !== "result") throw new Error("initialize failed");
const lease = await send("session.acquire", { sessionId: "probe-session", viewId: "probe", mode: "controller" });
console.log("LEASE", JSON.stringify(lease));
const leaseId = lease.data.lease.leaseId;
const submit = await send("session.submitPrompt", {
  sessionId: "probe-session", leaseId, turnId: "probe-turn",
  input: { prompt: "probe release host", provider: { baseUrl, apiKey: "probe-secret" }, workspace: join(root, "app-data") },
});
console.log("SUBMIT", JSON.stringify(submit));
let snapshot: any;
for (let i = 0; i < 80; i++) {
  snapshot = await send("session.snapshot", { sessionId: "probe-session" });
  const text = JSON.stringify(snapshot);
  if (text.includes("durableFacts") && text.includes("probe release host")) break;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
}
console.log("SNAPSHOT", JSON.stringify(snapshot));
const cancelled = await send("session.cancel", { sessionId: "probe-session", leaseId, turnId: "probe-turn" });
console.log("CANCEL", JSON.stringify(cancelled));
const stopped = await send("shutdown", { reason: "probe" });
console.log("SHUTDOWN", JSON.stringify(stopped));
child.stdin.end();
await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
server.close();
if (requests.length !== 1) throw new Error(`expected one provider request, got ${requests.length}`);
if (snapshot?.type !== "result" || snapshot.data?.snapshot?.cursor === undefined) throw new Error("snapshot did not contain a cursor");
