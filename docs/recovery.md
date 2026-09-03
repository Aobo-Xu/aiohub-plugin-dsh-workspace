# Recovery and data retention

The Supervisor fences every resident process with a domain generation and every
mutable session action with a controller lease. On cancellation, flush, or
shutdown it terminates managed descendants before the Sidecar exits.

After a crash, an active turn is recorded as interrupted. Cold recovery may
restore readiness and durable snapshots, but it never automatically replays a
prompt, model request, tool effect, or other side effect. Retry requires a new
turn identifier.

Upgrade, failed rollback, and uninstall preserve plugin-owned session data
until the user explicitly removes it. Uninstall removes the installed plugin
payload, not user data. Recovery diagnostics are redacted before export.
