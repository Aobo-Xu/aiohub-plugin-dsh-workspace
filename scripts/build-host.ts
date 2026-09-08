import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildHost(root: string): Promise<string> {
  const output = join(root, "dist", "host", "aio-dsh-host.mjs");
  await mkdir(dirname(output), { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(root, "packages", "dsh-bridge", "src", "host", "cordis-plugin.ts")],
    outdir: dirname(output),
    naming: "aio-dsh-host.mjs",
    target: "node",
    format: "esm",
    minify: false,
    sourcemap: "none",
  });
  if (!result.success) {
    throw new Error(`HOST_BUILD_FAILED: ${result.logs.map((log) => log.message).join("; ")}`);
  }
  return output;
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  console.log(await buildHost(root));
}
