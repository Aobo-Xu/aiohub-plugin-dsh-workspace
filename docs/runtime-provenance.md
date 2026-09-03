# Runtime provenance

The Windows runtime is built from the fixed official DSH source tag
`dsh-v0.1.2-alpha.5` at commit
`db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5`. Its contract hash, toolchain,
runtime closure, SHA-256 values, license result, and CycloneDX SBOM path are
the source-controlled facts in `runtime-lock/dsh-v0.1.2-alpha.5.json`.

Acquisition/build may access the network only for those fixed inputs. Packaging
and native runtime tests are separate offline stages. The final ZIP persists a
platform-scoped `runtime-lock.json`, release closure hashes, MIT runtime and
Apache-2.0 Supervisor license texts, SBOM, support result, and ZIP SHA-256
sidecar. An alpha.1 runtime is not an acceptable fallback.
