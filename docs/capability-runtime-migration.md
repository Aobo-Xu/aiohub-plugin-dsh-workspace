# Compatibility and future migration

The supported model baseline is the explicit VCP/OpenAI-compatible Chat
Completions adapter. Unsupported provider fields produce structured errors;
there is no name-based routing or silent fallback. The scoped literal
placeholder codec preserves `{{Nova}}` where the pinned DSH interpolator
requires it.

The current `RuntimeFacade` and protocol DTOs are the migration boundary. A
future global Capability Runtime, `CredentialProvider`, `ModelTransport`, or
model broker must register an adapter to that boundary rather than replacing
the resident Sidecar protocol. The plugin intentionally has no UI, marketplace,
RAG, or Knowledge integration in this change.
