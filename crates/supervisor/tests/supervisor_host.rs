use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use aio_dsh_supervisor::{
    DshHomeLayout, PlatformTarget, ProcessBackend, RedactionPolicy, SpawnSpec, StartupFlags,
    Supervisor, SupervisorConfig,
};

struct TempRoot(PathBuf);

impl TempRoot {
    fn new(label: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "aio-dsh-supervisor-host-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).expect("create temp root");
        Self(path)
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_lock(root: &Path) -> PathBuf {
    let lock = serde_json::json!({
        "schemaVersion": 1,
        "version": "0.1.2-rc.1",
        "tag": "dsh-v0.1.2-rc.1",
        "commit": "0552c4d856929a6bfa70fce3baf39d8e946459dc",
        "publishedAt": "2026-08-28T00:00:00Z",
        "source": { "kind": "official-wheel", "url": "https://files.pythonhosted.org/packages/fixed/runtime.whl", "sha256": "1".repeat(64) },
        "officialWheel": { "status": "available" },
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
    });
    let path = root.join("dsh-runtime.json");
    fs::write(&path, serde_json::to_vec(&lock).expect("serialize lock")).expect("write lock");
    path
}

fn config(root: &Path, data_dir: &Path) -> SupervisorConfig {
    SupervisorConfig {
        plugin_data_dir: data_dir.to_owned(),
        runtime_lock_path: write_lock(root),
        runtime_root: root.join("runtime"),
        platform: PlatformTarget::Win32X64,
        host_api_version: 3,
        prewarm: false,
        telemetry_enabled: false,
        redaction: RedactionPolicy::default(),
    }
}

#[test]
fn repeated_start_reuses_one_long_lived_host_process() {
    let root = TempRoot::new("reuse");
    let data_dir = root.0.join("managed-home");
    let supervisor = Supervisor::new(config(&root.0, &data_dir)).expect("create supervisor");
    let flags = StartupFlags {
        child: Some(long_running_process()),
        ..StartupFlags::default()
    };

    supervisor.startup_transaction(&flags).expect("start host");
    let first = supervisor.host_process_id().expect("host pid");
    supervisor.startup_transaction(&flags).expect("reuse host");

    assert_eq!(supervisor.host_process_id(), Some(first));
    supervisor.shutdown().expect("shutdown host");
}

#[test]
fn managed_home_is_explicit_and_never_uses_the_ambient_dsh_home() {
    let root = TempRoot::new("home-env");
    let managed = root.0.join("managed-home");
    let ambient = root.0.join("ambient-home");
    let home = DshHomeLayout::create(&managed).expect("create managed home");
    let mut inherited = BTreeMap::from([("DSH_HOME".to_owned(), ambient.as_os_str().to_owned())]);

    home.apply_environment(&mut inherited);

    assert_eq!(
        inherited.get("DSH_HOME"),
        Some(&managed.as_os_str().to_owned())
    );
    assert_ne!(
        inherited.get("DSH_HOME"),
        Some(&ambient.as_os_str().to_owned())
    );
    assert_eq!(
        inherited.get("DSH_TELEMETRY_DISABLED"),
        Some(&OsString::from("1"))
    );
}

#[test]
fn managed_home_backup_copies_host_data_but_not_workspace_sources() {
    let root = TempRoot::new("backup");
    let managed = root.0.join("managed-home");
    let workspace = root.0.join("workspace-source");
    let backup = root.0.join("backup");
    let home = DshHomeLayout::create(&managed).expect("create managed home");
    fs::create_dir_all(&workspace).expect("create workspace");
    fs::write(home.data_dir().join("host-state.json"), b"host-state").expect("write host data");
    fs::write(workspace.join("user-source.rs"), b"user source").expect("write workspace");

    home.backup_to(&backup).expect("backup managed home");

    assert_eq!(
        fs::read(backup.join("data/host-state.json")).expect("read backed up host data"),
        b"host-state"
    );
    assert!(!backup.join("workspace-source/user-source.rs").exists());
}

#[test]
fn managed_home_backup_rejects_a_destination_inside_the_live_home() {
    let root = TempRoot::new("nested-backup");
    let managed = root.0.join("managed-home");
    let home = DshHomeLayout::create(&managed).expect("create managed home");

    assert!(home.backup_to(&managed.join("nested-backup")).is_err());
    assert!(!managed.join("nested-backup").exists());
}

#[test]
fn managed_environment_reaches_the_host_child_process() {
    let root = TempRoot::new("child-env");
    let output = root.0.join("child-home.txt");
    let expected = root.0.join("受管-home");
    let mut environment = BTreeMap::new();
    environment.insert("DSH_HOME".to_owned(), expected.as_os_str().to_owned());
    let backend = ProcessBackend::create().expect("create process backend");
    let mut process = backend
        .spawn(environment_probe(&output, environment))
        .expect("spawn environment probe");

    assert!(
        process
            .wait()
            .expect("wait for environment probe")
            .success()
    );
    assert_eq!(
        fs::read_to_string(output)
            .expect("read environment probe")
            .trim(),
        expected.to_string_lossy()
    );
}

#[test]
fn managed_host_process_round_trips_jsonl_and_closes_stdin_for_shutdown() {
    let backend = ProcessBackend::create().expect("create process backend");
    let mut process = backend
        .spawn_host(jsonl_echo_process())
        .expect("spawn managed host");

    assert_eq!(
        process
            .request_line(r#"{"id":1,"method":"initialize"}"#)
            .expect("host response"),
        r#"{"id":1,"type":"result"}"#
    );
    backend
        .shutdown_host(&mut process, Some(r#"{"id":2,"method":"shutdown"}"#))
        .expect("graceful host shutdown");
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
            env: BTreeMap::<String, OsString>::new(),
        }
    }

    #[cfg(unix)]
    {
        SpawnSpec {
            program: "sh".into(),
            args: vec!["-c".into(), "sleep 10".into()],
            current_dir: None,
            env: BTreeMap::<String, OsString>::new(),
        }
    }
}

fn environment_probe(output: &Path, env: BTreeMap<String, OsString>) -> SpawnSpec {
    let mut env = env;
    env.insert("PROBE_OUTPUT".to_owned(), output.as_os_str().to_owned());
    #[cfg(windows)]
    {
        SpawnSpec {
            program: "powershell.exe".into(),
            args: vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "[IO.File]::WriteAllText($env:PROBE_OUTPUT, $env:DSH_HOME)".into(),
            ],
            current_dir: None,
            env,
        }
    }

    #[cfg(unix)]
    {
        SpawnSpec {
            program: "sh".into(),
            args: vec![
                "-c".into(),
                "printf %s \"$DSH_HOME\" > \"$PROBE_OUTPUT\"".into(),
            ],
            current_dir: None,
            env,
        }
    }
}

fn jsonl_echo_process() -> SpawnSpec {
    #[cfg(windows)]
    {
        SpawnSpec {
            program: "powershell.exe".into(),
            args: vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                "$first=[Console]::In.ReadLine(); [Console]::Out.WriteLine('{\"id\":1,\"type\":\"result\"}'); [Console]::Out.Flush(); $null=[Console]::In.ReadLine()".into(),
            ],
            current_dir: None,
            env: BTreeMap::new(),
        }
    }

    #[cfg(unix)]
    {
        SpawnSpec {
            program: "sh".into(),
            args: vec![
                "-c".into(),
                "read first; printf '%s\\n' '{\"id\":1,\"type\":\"result\"}'; read second".into(),
            ],
            current_dir: None,
            env: BTreeMap::new(),
        }
    }
}
