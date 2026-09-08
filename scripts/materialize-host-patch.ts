import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export type MaterializeHostPatchOptions = {
  template: string;
  output: string;
  hostModule: string;
};

const HOST_MODULE_PLACEHOLDER = "__AIO_DSH_HOST_MODULE__";

/** Render an installed absolute module path without enabling executable YAML. */
export async function materializeHostPatch(options: MaterializeHostPatchOptions): Promise<void> {
  const template = await readFile(options.template, "utf8");
  if (!template.includes(HOST_MODULE_PLACEHOLDER)) {
    throw new Error("HOST_PATCH_PLACEHOLDER_MISSING");
  }
  const moduleUrl = pathToFileURL(options.hostModule).href;
  const yamlString = `'${moduleUrl.replaceAll("'", "''")}'`;
  const rendered = template.replaceAll(HOST_MODULE_PLACEHOLDER, yamlString);
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, rendered);
}
