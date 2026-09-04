# DSH Coding Workspace

DSH Coding Workspace is an independent AIO Hub Sidecar plugin. Its first
release supports **Windows x64 only** and ships the DSH `v0.1.2-rc.1`
official Windows wheel runtime as an offline ZIP. The versioned provenance is
read only from `runtime-lock/dsh-runtime.json`; release code and tests do not
embed the DSH version, so later upgrades update the lock and verified artifacts
without changing the Supervisor or packager. It adds no Coding Workspace UI,
marketplace flow, RAG, or Knowledge capability.

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
