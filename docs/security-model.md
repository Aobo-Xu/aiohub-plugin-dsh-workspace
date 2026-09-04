# Security model

The Supervisor is a resident Sidecar. Its stdout is JSON Lines protocol only;
diagnostics go to redacted plugin-owned logs. `AIOHUB_PLUGIN_DATA_DIR` is the
only host-injected data boundary. The Supervisor creates owner-only data,
session, credential, runtime, log, and temporary locations below it.

The default policy is `workspace-write + ask`. Full access is an explicit,
non-persistent user choice. A missing required sandbox capability fails closed;
the process-tree manager is not described as a sandbox. The locked DSH runtime and its
sandbox boundaries remain unaudited, so credential and workspace access should
be treated accordingly.

Only the model credentials supplied for the current operation are mirrored.
Support reports redact credentials, authorization headers, query secrets,
environment values, child output, crash records, and credential documents.
