# DSH Coding Workspace

DSH Coding Workspace is an independent AIO Hub Sidecar plugin. Its first
release supports **Windows x64 only** and ships the DSH `v0.1.2-rc.1`
official Windows wheel runtime as an offline ZIP. The versioned provenance is
read only from `runtime-lock/dsh-runtime.json`; release code and tests do not
embed the DSH version, so later upgrades update the lock and verified artifacts
without changing the Supervisor or packager. It adds no Coding Workspace UI,
marketplace flow, RAG, or Knowledge capability.

The Supervisor owns process lifecycle, sandboxing, generation/lease fencing and
the exactly-once mutation ledger. A long-lived managed DSH Host (the Cordis
production entry `host/aio-dsh-host.mjs`, bundled by `bun run build:host` and
shipped inside the release ZIP) serves the authoritative session facts through
release adapters: `v0.1.2-rc.1` is the implementation baseline (official wheel
pinned in the runtime lock); `v0.1.3-alpha.2` is a compatibility adapter whose
wheel acquisition is pending upstream publication. Adapter selection uses
public service/schema evidence only — never version-name inference — and an
unmatched release fails closed as `incompatible`. The TypeScript RuntimeFacade
exposes capability-gated DTOs to consumers; operations the active release does
not prove are reported unavailable instead of being simulated.

Install the release ZIP through AIO Hub's plugin installer. The installer
selects `bin/win32-x64/aio-dsh-supervisor.exe` from `manifest.json`; do not run
or copy files from Cargo's `target` directory as a substitute for that flow.

For local AIO Hub development, create the intentionally untracked junction:

```sh
bun run plugin:dsh:link
```

The wheel URL/hash, extracted-file hashes, verification metadata, upstream
license/notices, SBOM, security boundaries,
recovery behavior, and compatibility limits are documented in `docs/`. Before
publishing, run `bun scripts/verify-release.ts` and `bun run package:platform`.
