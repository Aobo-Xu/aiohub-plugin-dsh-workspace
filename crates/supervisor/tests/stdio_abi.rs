use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

use aio_dsh_protocol::{
    CommandPayload, Envelope, InitializeRequest, PlatformFacts, PlatformKey, RuntimeProvenance,
    SandboxBackend, SandboxLevel, SandboxStatus, SessionCommand, ShutdownReason,
};
use serde_json::{Value, json};

const CONTRACT_HASH: &str = "96af8af6cdb538da2cd13c53eb4dd640f0ca233aab68b209d82fc744e01da519";

fn initialize_request() -> InitializeRequest {
    InitializeRequest {
        protocol_version: aio_dsh_protocol::ProtocolVersion { major: 1, minor: 0 },
        contract_hash: CONTRACT_HASH.to_owned(),
        runtime: RuntimeProvenance {
            component: "stdio-test-runtime".to_owned(),
            version: "9.8.7-rc.6".to_owned(),
            build_id: "stdio-test-build".to_owned(),
            source_revision: Some("a66e4702047846cdaa10c66c9d3df3951f5ea70d".to_owned()),
        },
        platform: PlatformFacts {
            platform: PlatformKey::Win32X64,
            architecture: "x64".to_owned(),
            sandbox: SandboxStatus {
                level: SandboxLevel::Full,
                backend: SandboxBackend::RestrictedToken,
                reason: None,
            },
        },
        stable_capabilities: vec!["session".to_owned(), "snapshot".to_owned()],
        required_stable_capabilities: vec![],
        experimental_capabilities: vec![],
    }
}

fn initialize_request_with_capabilities(stable_capabilities: &[&str]) -> InitializeRequest {
    InitializeRequest {
        stable_capabilities: stable_capabilities
            .iter()
            .map(|capability| capability.to_string())
            .collect(),
        ..initialize_request()
    }
}

fn command(payload: CommandPayload, seq: u64, generation: &str) -> String {
    serde_json::to_string(&Envelope::new(generation, seq, payload)).expect("serialize command")
}

struct TempRoot(PathBuf);

impl TempRoot {
    fn new(label: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "aio-dsh-supervisor-stdio-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).expect("create temp root");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct RuntimeFixture {
    _root: TempRoot,
    plugin_data_dir: PathBuf,
    runtime_lock_path: PathBuf,
    runtime_root: PathBuf,
}

impl RuntimeFixture {
    fn new(label: &str) -> Self {
        let root = TempRoot::new(label);
        let plugin_data_dir = root.path().join("plugin-data");
        let runtime_root = root.path().join("runtime-root");
        fs::create_dir_all(&plugin_data_dir).expect("create plugin data dir");
        fs::create_dir_all(&runtime_root).expect("create runtime root");
        fs::write(
            runtime_root.join("deepseek-harness-sdk-runtime-win-x64.exe"),
            b"runtime",
        )
        .expect("write runtime exe");
        fs::write(
            runtime_root.join("deepseek-harness-sdk-runtime-win-x64-rg.exe"),
            b"rg",
        )
        .expect("write companion rg");

        let runtime_lock_path = root.path().join("dsh-runtime.json");
        fs::write(
            &runtime_lock_path,
            serde_json::to_vec(&lock_builder()).expect("serialize lock"),
        )
        .expect("write runtime lock");

        Self {
            _root: root,
            plugin_data_dir,
            runtime_lock_path,
            runtime_root,
        }
    }
}

struct ChildHarness {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<String>,
    stderr_rx: Receiver<String>,
}

impl ChildHarness {
    fn spawn(fixture: &RuntimeFixture) -> Self {
        Self::spawn_with_crash_token(fixture, None)
    }

    fn spawn_with_crash_token(fixture: &RuntimeFixture, crash_token: Option<&str>) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_aio-dsh-supervisor"));
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env(
                "AIO_DSH_SUPERVISOR_PLUGIN_DATA_DIR",
                &fixture.plugin_data_dir,
            )
            .env(
                "AIO_DSH_SUPERVISOR_RUNTIME_LOCK_PATH",
                &fixture.runtime_lock_path,
            )
            .env("AIO_DSH_SUPERVISOR_RUNTIME_ROOT", &fixture.runtime_root)
            .env("AIO_DSH_SUPERVISOR_PLATFORM", "win32-x64")
            .env("AIO_DSH_SUPERVISOR_HOST_API_VERSION", "3")
            .env("AIO_DSH_SUPERVISOR_PREWARM", "0")
            .env("AIO_DSH_SUPERVISOR_TELEMETRY", "0");
        if let Some(token) = crash_token {
            command.env("AIO_DSH_E2E_CRASH_TOKEN", token);
        }

        let mut child = command.spawn().expect("spawn supervisor binary");
        let stdin = child.stdin.take().expect("capture stdin");
        let stdout = child.stdout.take().expect("capture stdout");
        let stderr = child.stderr.take().expect("capture stderr");
        let (tx, rx) = mpsc::channel();
        let (stderr_tx, stderr_rx) = mpsc::channel();

        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let line = line.trim_end_matches(&['\r', '\n'][..]).to_owned();
                        if tx.send(line).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        std::thread::spawn(move || drain_diagnostics(stderr, stderr_tx));

        Self {
            child,
            stdin,
            rx,
            stderr_rx,
        }
    }

    fn spawn_from_release_layout(fixture: &RuntimeFixture) -> Self {
        let release_root = fixture._root.path().join("installed-plugin");
        let runtime_root = release_root.join("bin");
        fs::create_dir_all(&runtime_root).expect("create release runtime root");
        fs::copy(
            fixture
                .runtime_root
                .join("deepseek-harness-sdk-runtime-win-x64.exe"),
            runtime_root.join("deepseek-harness-sdk-runtime-win-x64.exe"),
        )
        .expect("stage release runtime exe");
        fs::copy(
            fixture
                .runtime_root
                .join("deepseek-harness-sdk-runtime-win-x64-rg.exe"),
            runtime_root.join("deepseek-harness-sdk-runtime-win-x64-rg.exe"),
        )
        .expect("stage release runtime companion");

        let mut scoped_lock = lock_builder();
        let object = scoped_lock.as_object_mut().expect("runtime lock object");
        object.remove("platforms");
        object.insert("platform".to_owned(), json!("win32-x64"));
        fs::write(
            release_root.join("runtime-lock.json"),
            serde_json::to_vec(&scoped_lock).expect("serialize scoped lock"),
        )
        .expect("write scoped release lock");

        let mut command = Command::new(env!("CARGO_BIN_EXE_aio-dsh-supervisor"));
        command
            .current_dir(&release_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("AIOHUB_PLUGIN_DATA_DIR", &fixture.plugin_data_dir);

        let mut child = command.spawn().expect("spawn installed supervisor binary");
        let stdin = child.stdin.take().expect("capture stdin");
        let stdout = child.stdout.take().expect("capture stdout");
        let stderr = child.stderr.take().expect("capture stderr");
        let (tx, rx) = mpsc::channel();
        let (stderr_tx, stderr_rx) = mpsc::channel();

        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let line = line.trim_end_matches(&['\r', '\n'][..]).to_owned();
                        if tx.send(line).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        std::thread::spawn(move || drain_diagnostics(stderr, stderr_tx));

        Self {
            child,
            stdin,
            rx,
            stderr_rx,
        }
    }

    fn send(&mut self, frame: &str) {
        self.stdin
            .write_all(frame.as_bytes())
            .expect("write frame to stdin");
        self.stdin.write_all(b"\n").expect("write newline");
        self.stdin.flush().expect("flush stdin");
    }

    fn recv_json(&self) -> Value {
        self.recv_json_timeout(Duration::from_secs(3))
    }

    fn recv_json_timeout(&self, timeout: Duration) -> Value {
        let line = self.rx.recv_timeout(timeout).expect("receive stdout line");
        serde_json::from_str(&line).expect("parse stdout json")
    }

    fn recv_json_frames(&self, count: usize) -> Vec<Value> {
        (0..count).map(|_| self.recv_json()).collect()
    }

    fn recv_json_where(&self, timeout: Duration, predicate: impl Fn(&Value) -> bool) -> Value {
        let start = std::time::Instant::now();
        loop {
            let remaining = timeout.saturating_sub(start.elapsed());
            let frame = self.recv_json_timeout(remaining.max(Duration::from_millis(1)));
            if predicate(&frame) {
                return frame;
            }
        }
    }

    fn assert_no_more_stdout(&self) {
        assert!(
            self.rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "stdout emitted an unexpected extra frame"
        );
    }

    fn finish(mut self) -> std::process::ExitStatus {
        drop(self.stdin);
        self.child.wait().expect("wait for child")
    }

    fn finish_with_stderr(mut self) -> (std::process::ExitStatus, Vec<String>) {
        drop(self.stdin);
        let status = self.child.wait().expect("wait for child");
        let stderr = self.stderr_rx.try_iter().collect();
        (status, stderr)
    }
}

fn drain_diagnostics(stream: ChildStderr, tx: mpsc::Sender<String>) {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let line = line.trim_end_matches(&['\r', '\n'][..]).to_owned();
                if tx.send(line).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

fn lock_builder() -> Value {
    json!({
        "schemaVersion": 1,
        "version": "9.8.7-rc.6",
        "tag": "dsh-v9.8.7-rc.6",
        "commit": "a66e4702047846cdaa10c66c9d3df3951f5ea70d",
        "publishedAt": "2026-09-04T03:14:50.092519Z",
        "source": {
            "kind": "official-wheel",
            "url": "https://files.pythonhosted.org/packages/fixed/runtime.whl",
            "sha256": "1111111111111111111111111111111111111111111111111111111111111111"
        },
        "officialWheel": { "status": "available" },
        "license": "MIT",
        "licenseResult": { "spdx": "MIT" },
        "cyclonedxPath": "sbom/runtime.cdx.json",
        "profileVersion": "dsh-runtime-profile-v1",
        "contractHash": CONTRACT_HASH,
        "aioSemverRange": ">=0.7.0-alpha.4",
        "toolchain": { "node": "not-applicable", "pnpm": "not-applicable", "python": "3.10", "rust": "not-applicable" },
        "platforms": {
            "win32-x64": { "platform": "win32-x64", "arch": "x64" }
        }
    })
}

#[test]
fn binary_emits_ready_then_stopped_over_real_stdio() {
    let fixture = RuntimeFixture::new("ready-stopped");
    let mut harness = ChildHarness::spawn(&fixture);

    harness.send(&command(
        CommandPayload::Initialize(initialize_request()),
        1,
        "bootstrap",
    ));
    let ready = harness.recv_json();
    assert_eq!(ready["payload"]["kind"], json!("state"));
    assert_eq!(ready["payload"]["data"]["state"], json!("ready"));
    assert!(
        ready["domainGenerationId"]
            .as_str()
            .expect("generation")
            .starts_with("dsh-generation-")
    );

    harness.send(&command(
        CommandPayload::Shutdown(aio_dsh_protocol::ShutdownRequest {
            reason: ShutdownReason::UserStop,
        }),
        2,
        ready["domainGenerationId"].as_str().expect("generation"),
    ));
    let stopped = harness.recv_json();
    assert_eq!(stopped["payload"]["kind"], json!("state"));
    assert_eq!(stopped["payload"]["data"]["state"], json!("stopped"));
    harness.assert_no_more_stdout();

    assert!(harness.finish().success());
}

#[test]
fn installed_sidecar_accepts_the_production_resident_json_rpc_envelope() {
    let fixture = RuntimeFixture::new("production-resident");
    let mut harness = ChildHarness::spawn_from_release_layout(&fixture);

    harness.send(
        &json!({
            "id": 1,
            "method": "initialize",
            "params": { "hostContext": { "apiVersion": 3, "sidecarProtocolVersion": 3 } }
        })
        .to_string(),
    );

    let initialized = harness.recv_json();
    assert_eq!(initialized["id"], json!(1));
    assert_eq!(initialized["type"], json!("result"));
    assert_eq!(initialized["data"]["state"], json!("ready"));
    assert!(
        initialized["data"]["domainGenerationId"]
            .as_str()
            .expect("production generation")
            .starts_with("dsh-generation-")
    );

    harness.send(&json!({ "id": 2, "method": "shutdown", "params": {} }).to_string());
    let stopped = harness.recv_json();
    assert_eq!(stopped["id"], json!(2));
    assert_eq!(stopped["type"], json!("result"));
    assert_eq!(stopped["data"]["state"], json!("stopped"));
    harness.assert_no_more_stdout();
    let (status, stderr) = harness.finish_with_stderr();
    assert!(status.success());
    assert!(
        stderr.is_empty(),
        "installed Sidecar leaked diagnostics: {stderr:?}"
    );
}

#[test]
fn initialize_failure_returns_one_structured_error_frame() {
    let fixture = RuntimeFixture::new("init-error");
    fs::remove_file(
        fixture
            .runtime_root
            .join("deepseek-harness-sdk-runtime-win-x64-rg.exe"),
    )
    .expect("remove companion runtime file");
    let mut harness = ChildHarness::spawn(&fixture);

    harness.send(&command(
        CommandPayload::Initialize(initialize_request()),
        1,
        "bootstrap",
    ));
    let error = harness.recv_json();
    assert_eq!(error["payload"]["kind"], json!("session"));
    assert_eq!(error["payload"]["data"]["kind"], json!("event"));
    assert_eq!(error["payload"]["data"]["data"]["kind"], json!("error"));
    harness.assert_no_more_stdout();

    assert!(harness.finish().success());
}

#[test]
fn malformed_and_schema_invalid_frames_emit_structured_wire_errors_without_starting_dsh() {
    let fixture = RuntimeFixture::new("wire-errors");
    let mut harness = ChildHarness::spawn(&fixture);

    harness.send("{not-json");
    let malformed = harness.recv_json();
    assert_eq!(malformed["payload"]["kind"], json!("session"));
    assert_eq!(malformed["payload"]["data"]["kind"], json!("event"));
    assert_eq!(malformed["payload"]["data"]["data"]["kind"], json!("error"));
    assert_eq!(
        malformed["payload"]["data"]["data"]["data"]["code"],
        json!("invalid-command-frame")
    );
    assert_eq!(malformed["domainGenerationId"], json!("connection-stopped"));

    harness.send(
        r#"{"protocolVersion":{"major":1,"minor":0},"contractHash":"96af8af6cdb538da2cd13c53eb4dd640f0ca233aab68b209d82fc744e01da519","domainGenerationId":"bootstrap","seq":2,"messageId":"message-2","payload":{"kind":"ping"},"unexpected":true}"#,
    );
    let invalid = harness.recv_json();
    assert_eq!(invalid["payload"]["kind"], json!("session"));
    assert_eq!(invalid["payload"]["data"]["kind"], json!("event"));
    assert_eq!(invalid["payload"]["data"]["data"]["kind"], json!("error"));
    assert_eq!(
        invalid["payload"]["data"]["data"]["data"]["code"],
        json!("invalid-command-frame")
    );
    assert_eq!(invalid["domainGenerationId"], json!("connection-stopped"));

    harness.send(&command(
        CommandPayload::Initialize(initialize_request()),
        3,
        "bootstrap",
    ));
    let ready = harness.recv_json();
    assert_eq!(ready["payload"]["kind"], json!("state"));
    assert_eq!(ready["payload"]["data"]["state"], json!("ready"));
    assert!(
        ready["domainGenerationId"]
            .as_str()
            .expect("generation")
            .ends_with("-1"),
        "bad frames must not mint a DSH generation before initialize succeeds"
    );

    harness.send(&command(
        CommandPayload::Shutdown(aio_dsh_protocol::ShutdownRequest {
            reason: ShutdownReason::UserStop,
        }),
        4,
        ready["domainGenerationId"].as_str().expect("generation"),
    ));
    let stopped = harness.recv_json();
    assert_eq!(stopped["payload"]["kind"], json!("state"));
    assert_eq!(stopped["payload"]["data"]["state"], json!("stopped"));
    harness.assert_no_more_stdout();

    let (status, stderr) = harness.finish_with_stderr();
    assert!(status.success());
    assert!(
        stderr.is_empty(),
        "wire errors must stay on stdout as structured JSONL, got stderr: {stderr:?}"
    );
}

#[test]
fn initialize_retry_after_failure_mints_a_fresh_generation() {
    let fixture = RuntimeFixture::new("retry-init");
    fs::remove_file(
        fixture
            .runtime_root
            .join("deepseek-harness-sdk-runtime-win-x64-rg.exe"),
    )
    .expect("remove companion runtime file");
    let mut harness = ChildHarness::spawn(&fixture);

    harness.send(&command(
        CommandPayload::Initialize(initialize_request()),
        1,
        "bootstrap",
    ));
    let failed = harness.recv_json();
    assert_eq!(failed["payload"]["kind"], json!("session"));
    assert_eq!(failed["payload"]["data"]["kind"], json!("event"));
    assert_eq!(failed["payload"]["data"]["data"]["kind"], json!("error"));
    assert_eq!(
        failed["payload"]["data"]["data"]["data"]["code"],
        json!("initialize-failed")
    );
    let failed_generation = failed["domainGenerationId"]
        .as_str()
        .expect("failed generation")
        .to_owned();

    fs::write(
        fixture
            .runtime_root
            .join("deepseek-harness-sdk-runtime-win-x64-rg.exe"),
        b"rg",
    )
    .expect("restore companion runtime file");

    harness.send(&command(
        CommandPayload::Initialize(initialize_request()),
        2,
        "bootstrap",
    ));
    let ready = harness.recv_json();
    assert_eq!(ready["payload"]["kind"], json!("state"));
    assert_eq!(ready["payload"]["data"]["state"], json!("ready"));
    let retried_generation = ready["domainGenerationId"]
        .as_str()
        .expect("retried generation");
    assert_ne!(retried_generation, failed_generation);

    harness.send(&command(
        CommandPayload::Shutdown(aio_dsh_protocol::ShutdownRequest {
            reason: ShutdownReason::UserStop,
        }),
        3,
        retried_generation,
    ));
    let stopped = harness.recv_json();
    assert_eq!(stopped["payload"]["kind"], json!("state"));
    assert_eq!(stopped["payload"]["data"]["state"], json!("stopped"));

    let (status, stderr) = harness.finish_with_stderr();
    assert!(status.success());
    assert!(stderr.is_empty());
}

#[test]
fn binary_publishes_fresh_generation_and_observable_lease_events() {
    let fixture_one = RuntimeFixture::new("gen-one");
    let mut first = ChildHarness::spawn(&fixture_one);
    first.send(&command(
        CommandPayload::Initialize(initialize_request()),
        1,
        "bootstrap-one",
    ));
    let first_ready = first.recv_json();
    let first_generation = first_ready["domainGenerationId"]
        .as_str()
        .expect("first generation")
        .to_owned();
    first.send(&command(
        CommandPayload::Shutdown(aio_dsh_protocol::ShutdownRequest {
            reason: ShutdownReason::UserStop,
        }),
        2,
        &first_generation,
    ));
    let _ = first.recv_json();
    assert!(first.finish().success());

    let fixture_two = RuntimeFixture::new("gen-two");
    let mut second = ChildHarness::spawn(&fixture_two);
    second.send(&command(
        CommandPayload::Initialize(initialize_request()),
        1,
        "bootstrap-two",
    ));
    let second_ready = second.recv_json();
    let second_generation = second_ready["domainGenerationId"]
        .as_str()
        .expect("second generation")
        .to_owned();
    assert_ne!(first_generation, second_generation);

    second.send(&command(
        CommandPayload::Session(SessionCommand::Acquire(
            aio_dsh_protocol::AcquireSessionRequest {
                request_id: "request-acquire".to_owned(),
                session_id: "session-1".to_owned(),
                view_id: "view-a".to_owned(),
                requested_mode: aio_dsh_protocol::LeaseMode::Controller,
            },
        )),
        2,
        &second_generation,
    ));
    let lease_response = second.recv_json();
    assert_eq!(lease_response["payload"]["kind"], json!("session"));
    assert_eq!(lease_response["payload"]["data"]["kind"], json!("lease"));
    let granted = second.recv_json();
    assert_eq!(granted["payload"]["kind"], json!("session"));
    assert_eq!(granted["payload"]["data"]["kind"], json!("event"));
    assert_eq!(
        granted["payload"]["data"]["data"]["kind"],
        json!("lease-granted")
    );

    second.send(&command(
        CommandPayload::Session(SessionCommand::Acquire(
            aio_dsh_protocol::AcquireSessionRequest {
                // A genuinely new acquire attempt carries a fresh request
                // identity; reusing request-acquire would be a retransmission
                // of the recorded first grant under the exactly-once ledger.
                request_id: "request-acquire-second".to_owned(),
                session_id: "session-1".to_owned(),
                view_id: "view-b".to_owned(),
                requested_mode: aio_dsh_protocol::LeaseMode::Controller,
            },
        )),
        3,
        &second_generation,
    ));
    let reject_frames = second.recv_json_frames(3);
    assert!(reject_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["kind"] == json!("accepted")
            && frame["payload"]["data"]["data"]["accepted"] == json!(false)
    }));
    assert!(reject_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["kind"] == json!("event")
            && frame["payload"]["data"]["data"]["kind"] == json!("lease-rejected")
    }));

    second.send(&command(
        CommandPayload::Shutdown(aio_dsh_protocol::ShutdownRequest {
            reason: ShutdownReason::UserStop,
        }),
        4,
        &second_generation,
    ));
    let shutdown_frames = second.recv_json_frames(2);
    assert!(shutdown_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("state")
            && frame["payload"]["data"]["state"] == json!("stopped")
    }));
    assert!(shutdown_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["kind"] == json!("event")
            && frame["payload"]["data"]["data"]["kind"] == json!("lease-released")
    }));
    second.assert_no_more_stdout();
    assert!(second.finish().success());
}

#[test]
fn binary_rejects_stale_and_unknown_leases_without_replacing_the_active_controller() {
    let fixture = RuntimeFixture::new("lease-guards");
    let mut harness = ChildHarness::spawn(&fixture);

    harness.send(&command(
        CommandPayload::Initialize(initialize_request()),
        1,
        "bootstrap",
    ));
    let ready = harness.recv_json();
    let generation = ready["domainGenerationId"]
        .as_str()
        .expect("generation")
        .to_owned();

    harness.send(&command(
        CommandPayload::Session(SessionCommand::Acquire(
            aio_dsh_protocol::AcquireSessionRequest {
                request_id: "request-acquire".to_owned(),
                session_id: "session-guarded".to_owned(),
                view_id: "view-a".to_owned(),
                requested_mode: aio_dsh_protocol::LeaseMode::Controller,
            },
        )),
        2,
        &generation,
    ));
    let original_lease = harness.recv_json();
    let _ = harness.recv_json();
    let original_lease_id = original_lease["payload"]["data"]["data"]["leaseId"]
        .as_str()
        .expect("original lease id")
        .to_owned();

    harness.send(&command(
        CommandPayload::Session(SessionCommand::TransferController(
            aio_dsh_protocol::TransferControllerRequest {
                request_id: "request-transfer".to_owned(),
                session_id: "session-guarded".to_owned(),
                lease_id: "lease-stale".to_owned(),
                target_view_id: "view-b".to_owned(),
            },
        )),
        3,
        &generation,
    ));
    let stale_frames = harness.recv_json_frames(2);
    assert!(stale_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["kind"] == json!("accepted")
            && frame["payload"]["data"]["data"]["accepted"] == json!(false)
    }));
    assert!(stale_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["kind"] == json!("event")
            && frame["payload"]["data"]["data"]["kind"] == json!("command-rejected")
            && frame["payload"]["data"]["data"]["data"]["code"] == json!("stale-lease")
    }));

    harness.send(&command(
        CommandPayload::Session(SessionCommand::TransferController(
            aio_dsh_protocol::TransferControllerRequest {
                request_id: "request-transfer".to_owned(),
                session_id: "unknown-session".to_owned(),
                lease_id: "lease-missing".to_owned(),
                target_view_id: "view-c".to_owned(),
            },
        )),
        4,
        &generation,
    ));
    let unknown_frames = harness.recv_json_frames(2);
    assert!(unknown_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["kind"] == json!("accepted")
            && frame["payload"]["data"]["data"]["accepted"] == json!(false)
    }));
    assert!(unknown_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["kind"] == json!("event")
            && frame["payload"]["data"]["data"]["kind"] == json!("command-rejected")
            && frame["payload"]["data"]["data"]["data"]["code"] == json!("unknown-lease")
    }));

    harness.send(&command(
        CommandPayload::Session(SessionCommand::Cancel(aio_dsh_protocol::CancelRequest {
            request_id: "request-cancel".to_owned(),
            session_id: "session-guarded".to_owned(),
            lease_id: original_lease_id,
            turn_id: "turn-still-active".to_owned(),
        })),
        5,
        &generation,
    ));
    let accepted = harness.recv_json();
    let accepted_event = harness.recv_json();
    assert_eq!(accepted["payload"]["data"]["data"]["accepted"], json!(true));
    assert_eq!(
        accepted_event["payload"]["data"]["data"]["kind"],
        json!("cancel-requested")
    );

    harness.send(&command(
        CommandPayload::Shutdown(aio_dsh_protocol::ShutdownRequest {
            reason: ShutdownReason::UserStop,
        }),
        6,
        &generation,
    ));
    let _ = harness.recv_json_frames(2);
    assert!(harness.finish().success());
}

#[test]
fn crash_recovery_persists_interrupted_turn_and_retry_does_not_replay_side_effect() {
    let fixture = RuntimeFixture::new("crash");
    let mut first = ChildHarness::spawn_with_crash_token(&fixture, Some("crash-token-42"));

    first.send(&command(
        CommandPayload::Initialize(initialize_request()),
        1,
        "bootstrap",
    ));
    let ready = first.recv_json();
    let generation = ready["domainGenerationId"]
        .as_str()
        .expect("generation")
        .to_owned();

    first.send(&command(
        CommandPayload::Session(SessionCommand::Acquire(
            aio_dsh_protocol::AcquireSessionRequest {
                request_id: "request-acquire".to_owned(),
                session_id: "session-2".to_owned(),
                view_id: "view-a".to_owned(),
                requested_mode: aio_dsh_protocol::LeaseMode::Controller,
            },
        )),
        2,
        &generation,
    ));
    let lease = first.recv_json();
    let _ = first.recv_json();
    let lease_id = lease["payload"]["data"]["data"]["leaseId"]
        .as_str()
        .expect("lease id")
        .to_owned();

    first.send(&command(
        CommandPayload::Session(SessionCommand::SubmitPrompt(
            aio_dsh_protocol::SubmitPromptRequest {
                session_id: "session-2".to_owned(),
                request_id: "turn-safe".to_owned(),
                lease_id: lease_id.clone(),
                turn_id: "turn-safe".to_owned(),
                input: json!({ "crashToken": "crash-token-42-extra" }),
            },
        )),
        3,
        &generation,
    ));
    let accepted = first.recv_json();
    let submitted = first.recv_json();
    assert_eq!(accepted["payload"]["data"]["data"]["accepted"], json!(true));
    assert_eq!(
        submitted["payload"]["data"]["data"]["kind"],
        json!("submit-prompt")
    );

    first.send(&command(
        CommandPayload::Session(SessionCommand::Cancel(aio_dsh_protocol::CancelRequest {
            request_id: "request-cancel".to_owned(),
            session_id: "session-2".to_owned(),
            lease_id: lease_id.clone(),
            turn_id: "turn-stale".to_owned(),
        })),
        4,
        "stale-generation",
    ));
    let reject_frames = first.recv_json_frames(2);
    assert!(reject_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["kind"] == json!("accepted")
            && frame["payload"]["data"]["data"]["accepted"] == json!(false)
    }));
    assert!(reject_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["kind"] == json!("event")
            && frame["payload"]["data"]["data"]["kind"] == json!("command-rejected")
            && frame["payload"]["data"]["data"]["data"]["code"] == json!("stale-generation")
    }));

    first.send(&command(
        CommandPayload::Session(SessionCommand::SubmitPrompt(
            aio_dsh_protocol::SubmitPromptRequest {
                session_id: "session-2".to_owned(),
                request_id: "turn-crash".to_owned(),
                lease_id,
                turn_id: "turn-crash".to_owned(),
                input: json!({ "crashToken": "crash-token-42" }),
            },
        )),
        5,
        &generation,
    ));
    let interrupted = first.recv_json();
    let crashed = first.recv_json();
    assert_eq!(interrupted["payload"]["kind"], json!("session"));
    assert_eq!(interrupted["payload"]["data"]["kind"], json!("event"));
    assert_eq!(
        interrupted["payload"]["data"]["data"]["kind"],
        json!("turn-interrupted")
    );
    assert_eq!(
        interrupted["payload"]["data"]["data"]["turnId"],
        json!("turn-crash")
    );
    assert_eq!(crashed["payload"]["kind"], json!("state"));
    assert_eq!(crashed["payload"]["data"]["state"], json!("crashed"));
    let (status, stderr) = first.finish_with_stderr();
    assert_eq!(status.code(), Some(86));
    assert!(stderr.is_empty());

    let mut second = ChildHarness::spawn(&fixture);
    second.send(&command(
        CommandPayload::Initialize(initialize_request()),
        1,
        "bootstrap-recovery",
    ));
    let recovered = second.recv_json();
    let recovered_generation = recovered["domainGenerationId"]
        .as_str()
        .expect("recovered generation")
        .to_owned();
    assert_ne!(recovered_generation, generation);

    second.send(&command(
        CommandPayload::Session(SessionCommand::Acquire(
            aio_dsh_protocol::AcquireSessionRequest {
                request_id: "request-acquire".to_owned(),
                session_id: "session-2".to_owned(),
                view_id: "view-recovery".to_owned(),
                requested_mode: aio_dsh_protocol::LeaseMode::Controller,
            },
        )),
        2,
        &recovered_generation,
    ));
    let recovered_lease = second.recv_json();
    let _ = second.recv_json();
    let recovered_lease_id = recovered_lease["payload"]["data"]["data"]["leaseId"]
        .as_str()
        .expect("recovered lease id")
        .to_owned();

    second.send(&command(
        CommandPayload::Session(SessionCommand::SubmitPrompt(
            aio_dsh_protocol::SubmitPromptRequest {
                session_id: "session-2".to_owned(),
                // Retry of the interrupted request keeps the same identity.
                request_id: "turn-crash".to_owned(),
                lease_id: recovered_lease_id.clone(),
                turn_id: "turn-crash".to_owned(),
                input: json!({ "retry": true }),
            },
        )),
        3,
        &recovered_generation,
    ));
    let retry_frames = second.recv_json_frames(2);
    assert!(retry_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["kind"] == json!("accepted")
            && frame["payload"]["data"]["data"]["accepted"] == json!(false)
    }));
    assert!(retry_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["kind"] == json!("event")
            && frame["payload"]["data"]["data"]["kind"] == json!("command-rejected")
            && frame["payload"]["data"]["data"]["data"]["code"] == json!("interrupted-turn")
    }));

    second.send(&command(
        CommandPayload::Session(SessionCommand::SubmitPrompt(
            aio_dsh_protocol::SubmitPromptRequest {
                session_id: "session-2".to_owned(),
                request_id: "turn-after-recovery".to_owned(),
                lease_id: recovered_lease_id,
                turn_id: "turn-after-recovery".to_owned(),
                input: json!({ "retry": false }),
            },
        )),
        4,
        &recovered_generation,
    ));
    let accepted_after_recovery = second.recv_json();
    let submitted_after_recovery = second.recv_json();
    assert_eq!(
        accepted_after_recovery["payload"]["data"]["data"]["accepted"],
        json!(true)
    );
    assert_eq!(
        submitted_after_recovery["payload"]["data"]["data"]["kind"],
        json!("submit-prompt")
    );

    second.send(&command(
        CommandPayload::Shutdown(aio_dsh_protocol::ShutdownRequest {
            reason: ShutdownReason::UserStop,
        }),
        5,
        &recovered_generation,
    ));
    let stopped = second.recv_json_where(Duration::from_secs(3), |frame| {
        frame["payload"]["kind"] == json!("state")
            && frame["payload"]["data"]["state"] == json!("stopped")
    });
    assert_eq!(stopped["payload"]["data"]["state"], json!("stopped"));
    second.assert_no_more_stdout();

    let (recovered_status, recovered_stderr) = second.finish_with_stderr();
    assert!(recovered_status.success());
    assert!(recovered_stderr.is_empty());
}

#[test]
fn corrupt_interrupted_turn_ledger_is_quarantined_and_startup_recovers() {
    let fixture = RuntimeFixture::new("corrupt-ledger");
    let ledger_dir = fixture.plugin_data_dir.join("runtime");
    fs::create_dir_all(&ledger_dir).expect("create ledger dir");
    let ledger_path = ledger_dir.join("interrupted-turns.json");
    let corrupt_bytes = b"{\"turns\": [broken";
    fs::write(&ledger_path, corrupt_bytes).expect("write corrupt ledger");

    let mut harness = ChildHarness::spawn(&fixture);
    harness.send(&command(
        CommandPayload::Initialize(initialize_request()),
        1,
        "bootstrap",
    ));
    let ready = harness.recv_json();
    assert_eq!(ready["payload"]["kind"], json!("state"));
    assert_eq!(ready["payload"]["data"]["state"], json!("ready"));

    let quarantined = ledger_dir.join("interrupted-turns.json.corrupt");
    assert!(
        quarantined.exists(),
        "corrupt ledger must be quarantined for operator inspection"
    );
    assert_eq!(
        fs::read(&quarantined).expect("read quarantined ledger"),
        corrupt_bytes
    );
    assert!(
        !ledger_path.exists(),
        "corrupt ledger path must be cleared so future writes start fresh"
    );

    let generation = ready["domainGenerationId"]
        .as_str()
        .expect("generation")
        .to_owned();
    harness.send(&command(
        CommandPayload::Shutdown(aio_dsh_protocol::ShutdownRequest {
            reason: ShutdownReason::UserStop,
        }),
        2,
        &generation,
    ));
    let stopped = harness.recv_json_where(Duration::from_secs(3), |frame| {
        frame["payload"]["kind"] == json!("state")
            && frame["payload"]["data"]["state"] == json!("stopped")
    });
    assert_eq!(stopped["payload"]["data"]["state"], json!("stopped"));
    let (status, _stderr) = harness.finish_with_stderr();
    assert!(status.success());
}

fn resident_command(id: u64, method: &str, params: Value) -> String {
    json!({ "id": id, "method": method, "params": params }).to_string()
}

#[test]
fn resident_session_commands_round_trip_through_the_host_envelope() {
    let fixture = RuntimeFixture::new("resident-session");
    let mut harness = ChildHarness::spawn(&fixture);

    harness.send(&resident_command(
        1,
        "initialize",
        json!({ "hostContext": { "apiVersion": 3, "sidecarProtocolVersion": 3 } }),
    ));
    let init = harness.recv_json();
    assert_eq!(init["type"], json!("result"));
    assert_eq!(init["data"]["state"], json!("ready"));
    let generation = init["data"]["domainGenerationId"]
        .as_str()
        .expect("generation")
        .to_owned();

    harness.send(&resident_command(
        2,
        "session.acquire",
        json!({ "sessionId": "s-1", "viewId": "view-a", "mode": "controller" }),
    ));
    let acquire = harness.recv_json();
    assert_eq!(acquire["type"], json!("result"));
    assert_eq!(acquire["data"]["domainGenerationId"], json!(generation));
    let lease_id = acquire["data"]["lease"]["leaseId"]
        .as_str()
        .expect("lease id")
        .to_owned();
    assert_eq!(
        acquire["data"]["lease"]["mode"],
        json!("controller"),
        "resident acquire must surface the granted lease mode"
    );

    harness.send(&resident_command(
        3,
        "session.submitPrompt",
        json!({
            "sessionId": "s-1",
            "leaseId": lease_id,
            "turnId": "turn-1",
            "input": { "prompt": "add a hello-world function" }
        }),
    ));
    let submit = harness.recv_json();
    assert_eq!(submit["type"], json!("result"));
    assert_eq!(submit["data"]["accepted"], json!(true));

    harness.send(&resident_command(
        4,
        "session.cancel",
        json!({ "sessionId": "s-1", "leaseId": lease_id, "turnId": "turn-1" }),
    ));
    let cancel = harness.recv_json();
    assert_eq!(cancel["type"], json!("result"));
    assert_eq!(cancel["data"]["accepted"], json!(true));

    harness.send(&resident_command(5, "shutdown", json!({})));
    let stopped = harness.recv_json();
    assert_eq!(stopped["type"], json!("result"));
    assert_eq!(stopped["data"]["state"], json!("stopped"));
    let (status, stderr) = harness.finish_with_stderr();
    assert!(status.success());
    assert!(stderr.is_empty());
}

#[test]
fn resident_session_commands_enforce_initialization_and_lease_fencing() {
    let fixture = RuntimeFixture::new("resident-fencing");
    let mut harness = ChildHarness::spawn(&fixture);

    harness.send(&resident_command(
        1,
        "session.acquire",
        json!({ "sessionId": "s-1", "viewId": "view-a", "mode": "controller" }),
    ));
    let early = harness.recv_json();
    assert_eq!(early["type"], json!("error"));
    assert_eq!(early["data"]["code"], json!("not-initialized"));

    harness.send(&resident_command(
        2,
        "initialize",
        json!({ "hostContext": { "apiVersion": 3, "sidecarProtocolVersion": 3 } }),
    ));
    let init = harness.recv_json();
    assert_eq!(init["data"]["state"], json!("ready"));

    harness.send(&resident_command(
        3,
        "session.acquire",
        json!({ "sessionId": "s-1", "viewId": "view-a", "mode": "controller" }),
    ));
    let acquire = harness.recv_json();
    let lease_id = acquire["data"]["lease"]["leaseId"]
        .as_str()
        .expect("lease id")
        .to_owned();

    harness.send(&resident_command(
        4,
        "session.acquire",
        json!({ "sessionId": "s-1", "viewId": "view-b", "mode": "controller" }),
    ));
    let duplicate = harness.recv_json();
    assert_eq!(duplicate["type"], json!("result"));
    assert_eq!(duplicate["data"]["accepted"], json!(false));
    assert_eq!(
        duplicate["data"]["rejection"]["code"],
        json!("lease-rejected")
    );

    harness.send(&resident_command(
        5,
        "session.submitPrompt",
        json!({
            "sessionId": "s-1",
            "leaseId": "lease-stale",
            "turnId": "turn-1",
            "input": { "prompt": "ignored" }
        }),
    ));
    let stale = harness.recv_json();
    assert_eq!(stale["data"]["accepted"], json!(false));
    assert_eq!(stale["data"]["rejection"]["code"], json!("stale-lease"));

    harness.send(&resident_command(
        6,
        "session.submitPrompt",
        json!({
            "sessionId": "s-1",
            "leaseId": lease_id,
            "turnId": "turn-2",
            "input": { "prompt": "real work" }
        }),
    ));
    let submit = harness.recv_json();
    assert_eq!(submit["data"]["accepted"], json!(true));

    harness.send(&resident_command(7, "shutdown", json!({})));
    let stopped = harness.recv_json();
    assert_eq!(stopped["data"]["state"], json!("stopped"));
    let (status, _stderr) = harness.finish_with_stderr();
    assert!(status.success());
}

#[test]
fn resident_session_retries_with_the_same_request_id_execute_the_mutation_once() {
    let fixture = RuntimeFixture::new("resident-exactly-once");
    let mut harness = ChildHarness::spawn(&fixture);

    harness.send(&resident_command(
        1,
        "initialize",
        json!({ "hostContext": { "apiVersion": 3, "sidecarProtocolVersion": 3 } }),
    ));
    let init = harness.recv_json();
    assert_eq!(init["data"]["state"], json!("ready"));
    let generation = init["data"]["domainGenerationId"]
        .as_str()
        .expect("generation")
        .to_owned();

    // The typed envelope path is used so every downstream frame stays
    // observable: counting the emitted lease-granted events is exactly how a
    // replayed mutation is told apart from a re-executed one.
    let acquire = |seq: u64, request_id: &str, view_id: &str| {
        command(
            CommandPayload::Session(SessionCommand::Acquire(
                aio_dsh_protocol::AcquireSessionRequest {
                    request_id: request_id.to_owned(),
                    session_id: "s-ledger".to_owned(),
                    view_id: view_id.to_owned(),
                    requested_mode: aio_dsh_protocol::LeaseMode::Controller,
                },
            )),
            seq,
            &generation,
        )
    };

    harness.send(&acquire(2, "request-dedupe", "view-a"));
    let granted = harness.recv_json();
    assert_eq!(granted["payload"]["kind"], json!("session"));
    assert_eq!(granted["payload"]["data"]["kind"], json!("lease"));
    let first_lease_id = granted["payload"]["data"]["data"]["leaseId"]
        .as_str()
        .expect("first lease id")
        .to_owned();
    let grant_event = harness.recv_json();
    assert_eq!(
        grant_event["payload"]["data"]["data"]["kind"],
        json!("lease-granted")
    );

    // Same requestId retransmission of the acquire mutation: the ledger must
    // return the recorded result instead of repeating the downstream
    // lease-minting transition. A second grant event would mean the downstream
    // side effect ran twice, so the replay returns the recorded lease response
    // and grant event verbatim with no fresh downstream execution.
    harness.send(&acquire(3, "request-dedupe", "view-a"));
    let replay_frames = harness.recv_json_frames(2);
    assert!(replay_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["kind"] == json!("lease")
            && frame["payload"]["data"]["data"]["leaseId"] == json!(first_lease_id)
    }));
    assert!(replay_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["kind"] == json!("event")
            && frame["payload"]["data"]["data"]["kind"] == json!("lease-granted")
    }));
    harness.assert_no_more_stdout();

    // A different request id for the same session is a genuinely new mutation,
    // so the downstream duplicate-controller guard rejects it.
    harness.send(&acquire(4, "request-other", "view-b"));
    let reject_frames = harness.recv_json_frames(3);
    assert!(reject_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["kind"] == json!("accepted")
            && frame["payload"]["data"]["data"]["accepted"] == json!(false)
    }));
    assert!(reject_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["data"]["kind"] == json!("lease-rejected")
    }));
    harness.assert_no_more_stdout();

    harness.send(&command(
        CommandPayload::Shutdown(aio_dsh_protocol::ShutdownRequest {
            reason: ShutdownReason::UserStop,
        }),
        5,
        &generation,
    ));
    let _stopped = harness.recv_json();
    assert!(harness.finish().success());
}

#[test]
fn mutations_from_stale_generation_or_lease_never_execute_and_stay_unrecorded() {
    let fixture = RuntimeFixture::new("stale-fencing");
    let mut harness = ChildHarness::spawn(&fixture);

    harness.send(&command(
        CommandPayload::Initialize(initialize_request()),
        1,
        "bootstrap",
    ));
    let ready = harness.recv_json();
    let generation = ready["domainGenerationId"]
        .as_str()
        .expect("generation")
        .to_owned();

    harness.send(&command(
        CommandPayload::Session(SessionCommand::Acquire(
            aio_dsh_protocol::AcquireSessionRequest {
                request_id: "request-acquire".to_owned(),
                session_id: "session-ledger".to_owned(),
                view_id: "view-a".to_owned(),
                requested_mode: aio_dsh_protocol::LeaseMode::Controller,
            },
        )),
        2,
        &generation,
    ));
    let lease = harness.recv_json();
    let _granted = harness.recv_json();
    let lease_id = lease["payload"]["data"]["data"]["leaseId"]
        .as_str()
        .expect("lease id")
        .to_owned();

    // A stale-generation mutation must be rejected before any downstream
    // transition and must not be recorded in the ledger: its request id must
    // stay unusable for replay within the live generation.
    harness.send(&command(
        CommandPayload::Session(SessionCommand::SubmitPrompt(
            aio_dsh_protocol::SubmitPromptRequest {
                session_id: "session-ledger".to_owned(),
                request_id: "request-stale-gen".to_owned(),
                lease_id: lease_id.clone(),
                turn_id: "turn-stale".to_owned(),
                input: json!({ "prompt": "stale generation" }),
            },
        )),
        3,
        "stale-generation",
    ));
    let stale_frames = harness.recv_json_frames(2);
    assert!(stale_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["kind"] == json!("accepted")
            && frame["payload"]["data"]["data"]["accepted"] == json!(false)
    }));
    assert!(stale_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["kind"] == json!("event")
            && frame["payload"]["data"]["data"]["kind"] == json!("command-rejected")
            && frame["payload"]["data"]["data"]["data"]["code"] == json!("stale-generation")
    }));
    harness.assert_no_more_stdout();

    // A stale-lease mutation is likewise rejected with a zero downstream
    // effect: no submit-prompt event besides the rejection is emitted.
    harness.send(&command(
        CommandPayload::Session(SessionCommand::SubmitPrompt(
            aio_dsh_protocol::SubmitPromptRequest {
                session_id: "session-ledger".to_owned(),
                request_id: "request-stale-lease".to_owned(),
                lease_id: "lease-stale".to_owned(),
                turn_id: "turn-stale-lease".to_owned(),
                input: json!({ "prompt": "stale lease" }),
            },
        )),
        4,
        &generation,
    ));
    let stale_lease_frames = harness.recv_json_frames(2);
    assert!(stale_lease_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["kind"] == json!("accepted")
            && frame["payload"]["data"]["data"]["accepted"] == json!(false)
    }));
    assert!(stale_lease_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["kind"] == json!("event")
            && frame["payload"]["data"]["data"]["kind"] == json!("command-rejected")
            && frame["payload"]["data"]["data"]["data"]["code"] == json!("stale-lease")
    }));
    harness.assert_no_more_stdout();

    // The live generation, the live lease and a fresh request id reach the
    // downstream host path: the submit-prompt event proves the mutation ran.
    harness.send(&command(
        CommandPayload::Session(SessionCommand::SubmitPrompt(
            aio_dsh_protocol::SubmitPromptRequest {
                session_id: "session-ledger".to_owned(),
                request_id: "request-live".to_owned(),
                lease_id: lease_id.clone(),
                turn_id: "turn-live".to_owned(),
                input: json!({ "prompt": "live work" }),
            },
        )),
        5,
        &generation,
    ));
    let accepted = harness.recv_json();
    assert_eq!(accepted["payload"]["data"]["data"]["accepted"], json!(true));
    let submitted = harness.recv_json();
    assert_eq!(
        submitted["payload"]["data"]["data"]["kind"],
        json!("submit-prompt")
    );

    // Retransmitting the live mutation keeps the downstream effect at one: the
    // recorded response and submit-prompt event are replayed verbatim.
    harness.send(&command(
        CommandPayload::Session(SessionCommand::SubmitPrompt(
            aio_dsh_protocol::SubmitPromptRequest {
                session_id: "session-ledger".to_owned(),
                request_id: "request-live".to_owned(),
                lease_id,
                turn_id: "turn-live".to_owned(),
                input: json!({ "prompt": "live work" }),
            },
        )),
        6,
        &generation,
    ));
    let replay_frames = harness.recv_json_frames(2);
    assert!(replay_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["kind"] == json!("accepted")
            && frame["payload"]["data"]["data"]["accepted"] == json!(true)
    }));
    assert!(replay_frames.iter().any(|frame| {
        frame["payload"]["kind"] == json!("session")
            && frame["payload"]["data"]["kind"] == json!("event")
            && frame["payload"]["data"]["data"]["kind"] == json!("submit-prompt")
    }));
    harness.assert_no_more_stdout();

    harness.send(&command(
        CommandPayload::Shutdown(aio_dsh_protocol::ShutdownRequest {
            reason: ShutdownReason::UserStop,
        }),
        7,
        &generation,
    ));
    let stopped = harness.recv_json_where(Duration::from_secs(3), |frame| {
        frame["payload"]["kind"] == json!("state")
            && frame["payload"]["data"]["state"] == json!("stopped")
    });
    assert_eq!(stopped["payload"]["data"]["state"], json!("stopped"));
    let (status, stderr) = harness.finish_with_stderr();
    assert!(status.success());
    assert!(stderr.is_empty());
}

#[test]
fn snapshot_commands_stay_available_when_only_the_session_capability_is_negotiated() {
    let fixture = RuntimeFixture::new("snapshot-capability");
    let mut harness = ChildHarness::spawn(&fixture);

    // The protocol capability catalog attaches session.snapshot to the
    // "session" capability, so a host that negotiated only {"session"} must
    // still be able to snapshot; the capability gate must agree with the
    // negotiated InitializeResult.operations.
    harness.send(&command(
        CommandPayload::Initialize(initialize_request_with_capabilities(&["session"])),
        1,
        "bootstrap",
    ));
    let ready = harness.recv_json();
    assert_eq!(ready["payload"]["kind"], json!("state"));
    assert_eq!(ready["payload"]["data"]["state"], json!("ready"));
    let generation = ready["domainGenerationId"]
        .as_str()
        .expect("generation")
        .to_owned();

    harness.send(&command(
        CommandPayload::Session(SessionCommand::Snapshot(
            aio_dsh_protocol::SnapshotRequest {
                session_id: "session-snapshot".to_owned(),
                cursor: None,
            },
        )),
        2,
        &generation,
    ));
    let snapshot = harness.recv_json();
    assert_eq!(snapshot["payload"]["kind"], json!("session"));
    assert_eq!(snapshot["payload"]["data"]["kind"], json!("snapshot"));
    assert_eq!(
        snapshot["payload"]["data"]["data"]["sessionId"],
        json!("session-snapshot")
    );
    harness.assert_no_more_stdout();

    harness.send(&command(
        CommandPayload::Shutdown(aio_dsh_protocol::ShutdownRequest {
            reason: ShutdownReason::UserStop,
        }),
        3,
        &generation,
    ));
    let _stopped = harness.recv_json();
    assert!(harness.finish().success());
}
