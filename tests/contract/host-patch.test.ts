import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeHostPatch } from "../../scripts/materialize-host-patch.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed DSH Host patch", () => {
  it("renders the installed Host module as a YAML-safe absolute string", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-host-patch-"));
    roots.push(root);
    const template = join(root, "cordis.patch.yml");
    const output = join(root, "managed", "cordis.patch.yml");
    await writeFile(template, "- insert:\n    - id: host\n      name: __AIO_DSH_HOST_MODULE__\n");

    await materializeHostPatch({
      template,
      output,
      hostModule: "C:\\Program Files\\AIO's Host\\aio-dsh-host.mjs",
    });

    const rendered = await readFile(output, "utf8");
    expect(rendered).toContain("name: 'file:///C:/Program%20Files/AIO''s%20Host/aio-dsh-host.mjs'");
    expect(rendered).not.toContain("__AIO_DSH_HOST_MODULE__");
    expect(rendered).not.toContain("!!js");
  });

  it("enables full-text session search in the shipped patch template", async () => {
    // Upstream ships session-query-sqlite with `openAt: never` (full-text
    // search is opt-in). The managed workstation deployment must enable it
    // through the documented patch-layer override with a durable index path
    // inside the managed DSH Home; otherwise every negotiated session.search
    // call fails with SESSION_QUERY_SEARCH_DISABLED at runtime.
    const template = await readFile(
      new URL("../../profiles/aio-coding/cordis.patch.yml", import.meta.url),
      "utf8",
    );
    // Assert on effective YAML only: explanatory comments may quote the
    // upstream `openAt: never` default without configuring it.
    const effective = template
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(effective).toContain("id: session-query-sqlite");
    expect(effective).toMatch(/openAt:\s*first-search/);
    expect(effective).toContain("dshHomePath(");
    expect(effective).not.toMatch(/openAt:\s*never/);
  });
});
