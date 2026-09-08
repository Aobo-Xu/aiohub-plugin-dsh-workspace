//! Test-only stub of the DSH Host JSONL surface.
//!
//! Speaks the minimal host wire protocol the Supervisor manages:
//! `initialize` becomes ready with a fixed capability set, `session.search`
//! answers with a structured error frame (the deployment-disabled search
//! shape observed in production), `shutdown` stops, and every other method
//! returns an empty result. Used by stdio-level tests to prove the Supervisor
//! converts Host operation failures into structured client errors instead of
//! exiting.
use std::io::{self, BufRead, Write};

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let request: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let id = request
            .get("id")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let method = request
            .get("method")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let response = match method {
            "initialize" => serde_json::json!({
                "id": id,
                "type": "result",
                "data": {
                    "state": "ready",
                    "adapter": { "adapterId": "host-test-stub" },
                    "capabilities": [
                        { "capabilityId": "session", "schemaRevision": 1, "stability": "stable", "mode": "read" },
                        { "capabilityId": "session.search", "schemaRevision": 1, "stability": "stable", "mode": "read" },
                        { "capabilityId": "workspace.follow", "schemaRevision": 1, "stability": "stable", "mode": "observe" },
                        { "capabilityId": "workspace.delete", "schemaRevision": 1, "stability": "stable", "mode": "mutate" },
                        { "capabilityId": "session.update-queue", "schemaRevision": 1, "stability": "stable", "mode": "mutate" }
                    ]
                }
            }),
            "session.search" => serde_json::json!({
                "id": id,
                "type": "error",
                "data": {
                    "code": "RemoteError",
                    "message": "session search failed: SessionQueryError: session search is disabled: this deployment configures the session-query index with openAt \"never\""
                }
            }),
            "workspace.remove" => serde_json::json!({
                "id": id,
                "type": "error",
                "data": {
                    "code": "Error",
                    "message": "workspace remove refused by stub"
                }
            }),
            "shutdown" => serde_json::json!({
                "id": id,
                "type": "result",
                "data": { "state": "stopped" }
            }),
            _ => serde_json::json!({
                "id": id,
                "type": "result",
                "data": {}
            }),
        };
        if writeln!(out, "{}", response).is_err() {
            break;
        }
        if out.flush().is_err() {
            break;
        }
        if method == "shutdown" {
            break;
        }
    }
}
