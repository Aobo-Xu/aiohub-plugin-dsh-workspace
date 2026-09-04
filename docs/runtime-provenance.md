# Runtime provenance

The Windows runtime is extracted from the official DSH `v0.1.2-rc.1`
`deepseek-harness-runtime-bin` wheel published on PyPI. The release tag/commit,
persistent wheel URL and SHA-256, runtime closure, extracted-file SHA-256 values,
upstream license/notices, and CycloneDX SBOM path are source-controlled facts in
the stable pointer `runtime-lock/dsh-runtime.json`.

Only wheel acquisition may access the network, and it verifies the complete
wheel before extracting its audited Windows closure. Packaging
and native runtime tests are separate offline stages. The final ZIP persists a
platform-scoped `runtime-lock.json`, release closure hashes, MIT runtime and
Apache-2.0 Supervisor license texts, SBOM, support result, and ZIP SHA-256
sidecar. No source-build or older prerelease fallback is allowed.

The resolver, packager, release verifier, Supervisor, and reusable tests do not
hard-code a DSH version. A later DSH upgrade changes the stable lock and its
derived hashes/SBOM; validation derives release identity from that lock.
