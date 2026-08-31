# Contributing

Use Bun 1.3.11 with Node.js 22.19.0 for repository scripts. Run `bun install` before adding JavaScript or TypeScript dependencies.

The DSH source-runtime build is pinned to pnpm 11.7.0 and Python 3.10. Do not substitute a different pnpm or Python version when producing runtime artifacts.

Keep generated protocol and runtime artifacts out of source changes unless the corresponding generation or packaging task explicitly requires them. Run the narrow relevant `bun` and Cargo checks before submitting a change.
