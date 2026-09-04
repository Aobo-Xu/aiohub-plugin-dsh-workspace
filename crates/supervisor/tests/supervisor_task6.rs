use std::collections::BTreeSet;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use aio_dsh_protocol::{
    CommandEnvelope, CommandPayload, Envelope, InitializeRequest, InitializeResult, PlatformFacts,
    PlatformKey, RuntimeProvenance, SandboxBackend, SandboxLevel, SandboxStatus,
};
use aio_dsh_supervisor::{
    ClientValidation, DshHomeLayout, PlatformTarget, RedactionPolicy, RuntimeValidator,
    StartupFlags, Supervisor, SupervisorConfig, SupervisorOwner,
};

fn initialize_request(contract_hash: &str) -> InitializeRequest {
    InitializeRequest {
        protocol_version: aio_dsh_protocol::ProtocolVersion { major: 1, minor: 0 },
        contract_hash: contract_hash.to_owned(),
        runtime: RuntimeProvenance {
            component: "dsh-runtime".to_owned(),
            version: "9.8.7-rc.6".to_owned(),
            build_id: "task-6-test".to_owned(),
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

fn command(frame: Envelope<CommandPayload>) -> CommandEnvelope {
    CommandEnvelope(frame)
}

fn envelope(payload: CommandPayload) -> Envelope<CommandPayload> {
    Envelope::new("generation-1", 1, payload)
}

struct TempRoot(PathBuf);

impl TempRoot {
    fn new(label: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "aio-dsh-supervisor-task6-{label}-{}-{}",
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

fn lock_builder() -> serde_json::Value {
    serde_json::json!({
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
        "officialWheel": {
            "status": "available"
        },
        "license": "MIT",
        "licenseResult": { "spdx": "MIT", "source": "upstream-package" },
        "cyclonedxPath": "sbom/runtime.cdx.json",
        "profileVersion": "dsh-runtime-profile-v1",
        "contractHash": "96af8af6cdb538da2cd13c53eb4dd640f0ca233aab68b209d82fc744e01da519",
        "aioSemverRange": ">=0.7.0-alpha.4",
        "toolchain": { "node": "not-applicable", "pnpm": "not-applicable", "python": "3.10", "rust": "not-applicable" },
        "platforms": {
            "win32-x64": {
                "platform": "win32-x64",
                "arch": "x64",
                "artifactState": { "status": "not-built", "reason": "native-runner-required" },
                "nodePkgTarget": "node24-win-x64",
                "pythonTarget": "win_amd64",
                "osFloor": { "kind": "windows", "version": "10" },
                "runtimeClosure": [
                    "bin/deepseek-harness-sdk-runtime-win-x64.exe",
                    "bin/deepseek-harness-sdk-runtime-win-x64-rg.exe"
                ],
                "files": []
            },
            "linux-x64": {
                "platform": "linux-x64",
                "arch": "x64",
                "artifactState": { "status": "not-built", "reason": "native-runner-required" },
                "nodePkgTarget": "node24-linux-x64",
                "pythonTarget": "manylinux_2_28_x86_64",
                "osFloor": { "kind": "glibc", "version": "2.28" },
                "runtimeClosure": [
                    "bin/deepseek-harness-sdk-runtime-linux-x64",
                    "bin/deepseek-harness-sdk-runtime-linux-x64-rg"
                ],
                "files": []
            },
            "darwin-arm64": {
                "platform": "darwin-arm64",
                "arch": "arm64",
                "artifactState": { "status": "not-built", "reason": "native-runner-required" },
                "nodePkgTarget": "node24-macos-arm64",
                "pythonTarget": "macosx_14_0_arm64",
                "osFloor": { "kind": "macos", "version": "14.0" },
                "runtimeClosure": [
                    "bin/deepseek-harness-sdk-runtime-macos-arm64",
                    "bin/deepseek-harness-sdk-runtime-macos-arm64-rg"
                ],
                "files": []
            },
            "linux-arm64": {
                "platform": "linux-arm64",
                "arch": "arm64",
                "artifactState": { "status": "not-built", "reason": "native-runner-required" },
                "nodePkgTarget": "node24-linux-arm64",
                "pythonTarget": "manylinux_2_28_aarch64",
                "osFloor": { "kind": "glibc", "version": "2.28" },
                "runtimeClosure": [
                    "bin/deepseek-harness-sdk-runtime-linux-arm64",
                    "bin/deepseek-harness-sdk-runtime-linux-arm64-rg"
                ],
                "files": []
            }
        }
    })
}

fn write_lock(root: &Path, value: &serde_json::Value) -> PathBuf {
    let path = root.join("dsh-runtime.json");
    fs::write(&path, serde_json::to_vec(value).expect("serialize lock")).expect("write lock");
    path
}

fn config(data_dir: &Path, lock_path: &Path) -> SupervisorConfig {
    SupervisorConfig {
        plugin_data_dir: data_dir.to_owned(),
        runtime_lock_path: lock_path.to_owned(),
        runtime_root: lock_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("runtime-root"),
        platform: PlatformTarget::Win32X64,
        host_api_version: 3,
        prewarm: false,
        telemetry_enabled: false,
        redaction: RedactionPolicy::default(),
    }
}

#[test]
fn runtime_validator_accepts_frozen_lock_for_known_platforms() {
    let root = TempRoot::new("validator-accept");
    let lock = write_lock(root.path(), &lock_builder());
    for (platform, expected) in [
        (PlatformTarget::Win32X64, "x64"),
        (PlatformTarget::LinuxX64, "x64"),
        (PlatformTarget::DarwinArm64, "arm64"),
        (PlatformTarget::LinuxArm64, "arm64"),
    ] {
        let validated = RuntimeValidator::validate(&lock, platform).expect("validate lock");
        assert_eq!(validated.architecture(), expected);
    }
}

#[test]
fn runtime_validator_accepts_a_future_lock_without_recompilation() {
    let root = TempRoot::new("validator-future-version");
    let mut lock = lock_builder();
    lock["version"] = serde_json::json!("9.8.7-rc.6");
    lock["tag"] = serde_json::json!("dsh-v9.8.7-rc.6");
    lock["commit"] = serde_json::json!("2222222222222222222222222222222222222222");
    assert!(
        RuntimeValidator::validate(&write_lock(root.path(), &lock), PlatformTarget::Win32X64,)
            .is_ok()
    );
}

#[test]
fn runtime_validator_rejects_unsupported_platform_and_contract_mismatch() {
    let root = TempRoot::new("validator-reject");
    assert!(
        RuntimeValidator::validate(&write_lock(root.path(), &lock_builder()), "not-a-platform",)
            .is_err()
    );

    let mut bad = lock_builder();
    bad["contractHash"] = serde_json::json!("f".repeat(64));
    assert!(
        RuntimeValidator::validate(&write_lock(root.path(), &bad), PlatformTarget::Win32X64,)
            .is_err()
    );
}

#[test]
fn runtime_validator_rejects_an_unavailable_wheel() {
    let root = TempRoot::new("validator-wheel-status");
    let mut lock = lock_builder();
    lock["officialWheel"]["status"] = serde_json::json!("unavailable");
    assert!(
        RuntimeValidator::validate(&write_lock(root.path(), &lock), PlatformTarget::Win32X64,)
            .is_err()
    );
}

#[test]
fn runtime_validator_rejects_runtime_layout_that_escapes_its_root() {
    let root = TempRoot::new("validator-layout");
    let lock = write_lock(root.path(), &lock_builder());
    let validated =
        RuntimeValidator::validate(&lock, PlatformTarget::Win32X64).expect("validate lock");
    let runtime_root = root.path().join("runtime-root");
    fs::create_dir_all(&runtime_root).expect("create runtime root");
    assert!(
        validated
            .validate_layout(&runtime_root, &["..\\runtime.exe"])
            .is_err()
    );
}

#[test]
fn home_layout_creates_owner_only_tree_and_secret_modes() {
    let root = TempRoot::new("home");
    let data_dir = root.path().join("data");
    let home = DshHomeLayout::create(&data_dir).expect("create home layout");

    for entry in home.entries() {
        assert!(
            entry.exists(),
            "home entry {} was not created",
            entry.display()
        );
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for entry in home.entries() {
            assert_eq!(
                fs::metadata(entry).expect("metadata").permissions().mode() & 0o777,
                0o700,
                "directory {} is not owner-only",
                entry.display()
            );
        }

        let secret = home.secret_file("credentials.json").expect("secret path");
        home.write_secret(&secret, b"secret")
            .expect("write secret file");
        assert_eq!(
            fs::metadata(secret)
                .expect("secret metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600,
        );
    }
}

#[test]
fn redaction_strips_credentials_headers_urls_env_and_server_secrets() {
    let policy = RedactionPolicy::default();
    let mut vars = BTreeSet::new();
    vars.insert("AIOHUB_CLIENT_SECRET".to_owned());
    vars.insert("CENSORED".to_owned());
    assert_eq!(
        policy.redact_env(&[
            ("AIOHUB_CLIENT_SECRET", "top-secret"),
            ("CENSORED", "also-secret"),
            ("AIOHUB_PLUGIN_DATA_DIR", "C:\\data"),
            ("SAFE_ENV", "safe"),
        ]),
        vec![
            ("AIOHUB_CLIENT_SECRET".to_owned(), "[redacted]".to_owned()),
            ("CENSORED".to_owned(), "[redacted]".to_owned()),
            ("AIOHUB_PLUGIN_DATA_DIR".to_owned(), "[redacted]".to_owned()),
            ("SAFE_ENV".to_owned(), "safe".to_owned()),
        ]
    );

    let header = "authorization";
    assert_eq!(
        policy.redact_header(header, "Bearer abc123"),
        ("authorization".to_owned(), "[redacted]".to_owned())
    );

    let url = "https://example.com/v1/models?api_key=abc&token=xyz";
    assert_eq!(
        policy.redact_url(url),
        "https://example.com/v1/models?[redacted]"
    );

    assert!(
        !policy
            .redact_text("child output leaked api_key=abc123 client_secret=top-secret")
            .contains("abc123")
    );
}

#[test]
fn supervisor_output_is_stdout_pure_json_lines() {
    let root = TempRoot::new("stdout");
    let data_dir = root.path().join("data");
    let lock = write_lock(root.path(), &lock_builder());
    let supervisor = Supervisor::new(config(&data_dir, &lock)).expect("create supervisor");

    let mut input = Cursor::new(Vec::new());
    let mut output = Vec::new();
    let flags = StartupFlags::default();
    supervisor
        .run_step(
            &format!(
                "{}\n",
                serde_json::to_string(&command(envelope(CommandPayload::Ping)))
                    .expect("serialize ping")
            ),
            &mut input,
            &mut output,
            &flags,
        )
        .expect("run hello line");

    let text = String::from_utf8(output).expect("utf8 stdout");
    for line in text.lines() {
        assert!(serde_json::from_str::<serde_json::Value>(line).is_ok());
    }
    assert!(!text.is_empty());
}

#[test]
fn initialize_command_responds_to_compatible_client() {
    let root = TempRoot::new("initialize");
    let data_dir = root.path().join("data");
    let lock = write_lock(root.path(), &lock_builder());
    let supervisor = Supervisor::new(config(&data_dir, &lock)).expect("create supervisor");

    let result = supervisor
        .initialize(&initialize_request(
            "96af8af6cdb538da2cd13c53eb4dd640f0ca233aab68b209d82fc744e01da519",
        ))
        .expect("initialize compatible client");
    assert!(matches!(result, InitializeResult { .. }));
}

#[test]
fn initialize_transaction_rolls_back_home_on_late_failure() {
    let root = TempRoot::new("rollback");
    let data_dir = root.path().join("data");
    let lock = write_lock(root.path(), &lock_builder());
    let supervisor = Supervisor::new(config(&data_dir, &lock)).expect("create supervisor");

    let flags = StartupFlags {
        fail_at_credentials: true,
        ..StartupFlags::default()
    };
    assert!(supervisor.startup_transaction(&flags).is_err());
    assert!(
        !data_dir.join("credentials").exists(),
        "credential directory must roll back after failure"
    );
}

#[test]
fn fail_closed_stubs_are_loadable_and_reject_use() {
    let root = TempRoot::new("stubs");
    let data_dir = root.path().join("data");
    let lock = write_lock(root.path(), &lock_builder());
    let supervisor = Supervisor::new(config(&data_dir, &lock)).expect("create supervisor");

    assert!(supervisor.validate_client(ClientValidation).is_ok());
    assert!(supervisor.secret_value("value").is_err());
    assert_eq!(supervisor.owner(), SupervisorOwner::Stopped);
}
