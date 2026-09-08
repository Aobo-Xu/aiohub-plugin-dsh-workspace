# Recovery and data retention

The Supervisor fences every resident process with a domain generation and every
mutable session action with a controller lease. On cancellation, flush, or
shutdown it terminates managed descendants before the Sidecar exits.

The managed DSH Host runs from an isolated plugin-owned DSH Home. The Supervisor
materializes one official Cordis patch inside that Home (currently disabling the
optional `session-title-llm` provider absent from the pinned wheel) and starts
the runtime with `--profile headless --patch <managed-patch>`; DSH sources are
never modified. Normal shutdown flushes official DSH durable services before
Cordis disposal, so the persisted session log survives the resident lifecycle.

After a crash, an active turn is recorded as interrupted. Cold recovery may
restore readiness and durable snapshots, but it never automatically replays a
prompt, model request, tool effect, or other side effect. Retry requires a new
turn identifier. Cold snapshot recovery rebuilds from DSH persistence: after a
resident restart with no live agent, `session.snapshot` returns the persisted
durable facts (verified end-to-end by the `dsh-host-capability` E2E lane), and
gap or generation changes force a snapshot-plus-cursor rebuild instead of an
event replay.

Approval interactions converge exactly once: the host broker pairs each DSH
`approval/asked` audit event with its `approval/decided` outcome, duplicate,
late, retracted, timed-out and stale-generation responses cannot resolve an
interaction twice, and an unknown or already-resolved correlation is rejected
fail-closed without touching DSH state.

Cross-release session migration goes only through the official
`DshReleaseAdapter.migrate()`; backup handles are opaque (no JSONL parsing, no
workspace/Git access). A failed or `not-migrated` official migration restores
the managed data, and a failed restore reports the stable
`SESSION_MIGRATION_RECOVERY_FAILED` code.

Upgrade, failed rollback, and uninstall preserve plugin-owned session data
until the user explicitly removes it. Uninstall removes the installed plugin
payload, not user data. Recovery diagnostics are redacted before export.

End-to-end crash coverage uses the `AIO_DSH_E2E_CRASH_TOKEN` environment
variable as an explicit test hook. When it is unset, prompt input containing a
crash token has no effect; the interrupted-turn ledger is written atomically,
and a torn ledger is quarantined to `interrupted-turns.json.corrupt` instead of
blocking cold recovery.
