use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use aio_dsh_supervisor::{
    DshHomeLayout, PlatformTarget, ProcessBackend, RedactionPolicy, RuntimeValidator, SpawnSpec,
    StartupFlags, Supervisor, SupervisorConfig,
};

fn lock_builder() -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "version": "9.8.7-rc.6",
        "tag": "dsh-v9.8.7-rc.6",
        "commit": "a66e4702047846cdaa10c66c9d3df3951f5ea70d",
        "publishedAt": "2026-09-02T07:48:33Z",
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
            "win32-x64": { "platform": "win32-x64", "arch": "x64" },
            "linux-x64": { "platform": "linux-x64", "arch": "x64" },
            "darwin-arm64": { "platform": "darwin-arm64", "arch": "arm64" },
            "linux-arm64": { "platform": "linux-arm64", "arch": "arm64" }
        }
    })
}

struct TempRoot(PathBuf);

impl TempRoot {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "aio-dsh-supervisor-review-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time after epoch")
                .as_nanos()
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

fn write_lock(root: &Path) -> PathBuf {
    let path = root.join("dsh-runtime.json");
    fs::write(
        &path,
        serde_json::to_vec(&lock_builder()).expect("serialize lock"),
    )
    .expect("write lock");
    path
}

fn config(root: &Path, lock: &Path, data_dir: &Path) -> SupervisorConfig {
    SupervisorConfig {
        plugin_data_dir: data_dir.to_owned(),
        runtime_lock_path: lock.to_owned(),
        runtime_root: root.join("runtime-root"),
        platform: PlatformTarget::Win32X64,
        host_api_version: 3,
        prewarm: false,
        telemetry_enabled: false,
        redaction: RedactionPolicy::default(),
    }
}

#[test]
fn supervisor_construction_returns_result_and_validates_host_and_telemetry() {
    let root = TempRoot::new("construct");
    let lock = write_lock(root.path());
    let data_dir = root.path().join("data");

    let mut valid = config(root.path(), &lock, &data_dir);
    assert!(Supervisor::new(valid.clone()).is_ok());

    valid.host_api_version = 4;
    assert!(Supervisor::new(valid.clone()).is_err());

    valid.host_api_version = 3;
    valid.telemetry_enabled = true;
    assert!(Supervisor::new(valid).is_err());
}

#[test]
fn prewarm_startup_creates_home_eagerly() {
    let root = TempRoot::new("prewarm");
    let lock = write_lock(root.path());
    let data_dir = root.path().join("data");
    let mut cfg = config(root.path(), &lock, &data_dir);
    cfg.prewarm = true;

    let supervisor = Supervisor::new(cfg).expect("prewarm supervisor");
    assert!(data_dir.exists());
    assert_eq!(
        supervisor.owner(),
        aio_dsh_supervisor::SupervisorOwner::Ready
    );
}

#[test]
fn supervisor_config_rejects_unsupported_host_and_telemetry() {
    let root = TempRoot::new("startup-options");
    let lock = write_lock(root.path());
    let data_dir = root.path().join("data");
    let mut cfg = config(root.path(), &lock, &data_dir);
    cfg.host_api_version = 4;
    assert!(Supervisor::new(cfg).is_err());
    assert!(!data_dir.exists());

    let mut cfg = config(root.path(), &lock, &data_dir);
    cfg.telemetry_enabled = true;
    assert!(Supervisor::new(cfg).is_err());
    assert!(!data_dir.exists());
}

#[test]
fn startup_transaction_rolls_back_home_and_child_on_protocol_failure() {
    let root = TempRoot::new("protocol-rollback");
    let lock = write_lock(root.path());
    let data_dir = root.path().join("data");
    let cfg = config(root.path(), &lock, &data_dir);
    let supervisor = Supervisor::new(cfg).expect("create supervisor");

    let flags = StartupFlags {
        fail_at_credentials: false,
        fail_at_child_settlement: false,
        fail_at_protocol: true,
        child: Some(long_running_process()),
    };

    assert!(supervisor.startup_transaction(&flags).is_err());
    assert!(!data_dir.exists());
}

#[test]
fn startup_transaction_rolls_back_when_child_settlement_fails() {
    let root = TempRoot::new("child-rollback");
    let lock = write_lock(root.path());
    let data_dir = root.path().join("data");
    let cfg = config(root.path(), &lock, &data_dir);
    let supervisor = Supervisor::new(cfg).expect("create supervisor");

    let flags = StartupFlags {
        fail_at_credentials: false,
        fail_at_child_settlement: true,
        fail_at_protocol: false,
        child: Some(long_running_process()),
    };

    assert!(supervisor.startup_transaction(&flags).is_err());
    assert!(!data_dir.exists());
}

#[test]
fn runtime_layout_validation_uses_explicit_root_not_process_cwd() {
    let root = TempRoot::new("runtime-root");
    let lock = write_lock(root.path());
    let runtime_root = root.path().join("runtime-root");
    fs::create_dir_all(&runtime_root).expect("create runtime root");

    let validated =
        RuntimeValidator::validate(&lock, PlatformTarget::Win32X64).expect("validate lock");
    assert!(
        validated
            .validate_layout(&runtime_root, &["Cargo.toml"])
            .is_err(),
        "layout validation must not fall back to the process CWD"
    );

    fs::write(runtime_root.join("runtime.exe"), b"runtime").expect("write runtime");
    assert!(
        validated
            .validate_layout(&runtime_root, &["runtime.exe"])
            .is_ok()
    );
}

#[test]
fn secret_files_are_created_exclusively() {
    let root = TempRoot::new("secret-exclusive");
    let data_dir = root.path().join("home");
    let home = DshHomeLayout::create(&data_dir).expect("create home");
    let secret = home.secret_file("credentials.json").expect("secret path");

    home.write_secret(&secret, b"first").expect("write secret");
    assert!(
        home.write_secret(&secret, b"second").is_err(),
        "secret creation must not overwrite an existing file"
    );
    assert_eq!(fs::read(&secret).expect("read secret"), b"first".to_vec());
}

#[test]
fn process_backend_spawns_and_terminates_a_tree() {
    let backend = ProcessBackend::create().expect("create process backend");
    let mut process = backend
        .spawn(long_running_process())
        .expect("spawn managed process");

    backend
        .terminate_tree(&mut process, Duration::from_millis(200))
        .expect("terminate process tree");
    assert!(process.wait().is_ok());
}

fn long_running_process() -> SpawnSpec {
    #[cfg(windows)]
    {
        SpawnSpec {
            program: "cmd".into(),
            args: vec![
                "/C".into(),
                "ping".into(),
                "-n".into(),
                "10".into(),
                "127.0.0.1".into(),
            ],
            current_dir: None,
        }
    }

    #[cfg(unix)]
    {
        SpawnSpec {
            program: "sh".into(),
            args: vec!["-c".into(), "sleep 10".into()],
            current_dir: None,
        }
    }

    #[cfg(not(any(windows, unix)))]
    {
        SpawnSpec {
            program: "unsupported".into(),
            args: Vec::new(),
            current_dir: None,
        }
    }
}
