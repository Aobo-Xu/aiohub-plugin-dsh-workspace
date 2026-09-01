use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use aio_dsh_supervisor::{Credentials, DshHomeLayout};

struct TempRoot(PathBuf);

impl TempRoot {
    fn new(label: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "aio-dsh-credentials-{label}-{}-{}",
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

fn home(root: &TempRoot) -> DshHomeLayout {
    DshHomeLayout::create(&root.path().join("data")).expect("create DSH home")
}

#[test]
fn replaces_the_current_document_and_clears_stale_refs() {
    let root = TempRoot::new("replace");
    let home = home(&root);
    let mut credentials = Credentials::new(home).expect("create credentials");

    credentials
        .replace(&[("AIO_PROFILE_ONE", "first-secret")])
        .expect("replace first credential");
    assert_eq!(
        credentials
            .resolve("AIO_PROFILE_ONE")
            .expect("resolve first credential")
            .expect("credential")
            .value()
            .expect("credential value"),
        "first-secret"
    );

    credentials
        .replace(&[("AIO_PROFILE_TWO", "second-secret")])
        .expect("replace credential set");
    assert!(
        credentials
            .resolve("AIO_PROFILE_ONE")
            .expect("resolve stale credential")
            .is_none()
    );
    assert_eq!(
        credentials
            .resolve("AIO_PROFILE_TWO")
            .expect("resolve current credential")
            .expect("credential")
            .value()
            .expect("credential value"),
        "second-secret"
    );

    let document = fs::read_to_string(root.path().join("data/credentials/credentials.json"))
        .expect("read credential document");
    assert!(document.contains("AIO_PROFILE_TWO"));
    assert!(!document.contains("AIO_PROFILE_ONE"));
    assert!(!document.contains("first-secret"));
}

#[test]
fn clear_removes_all_current_refs() {
    let root = TempRoot::new("clear");
    let home = home(&root);
    let mut credentials = Credentials::new(home).expect("create credentials");

    credentials
        .replace(&[("AIO_PROFILE_ONE", "secret")])
        .expect("replace credential");
    credentials.clear().expect("clear credentials");

    assert!(
        credentials
            .resolve("AIO_PROFILE_ONE")
            .expect("resolve cleared credential")
            .is_none()
    );
    assert_eq!(
        credentials
            .describe("AIO_PROFILE_ONE")
            .expect("describe cleared credential"),
        aio_dsh_supervisor::credentials::CredentialInfo {
            configured: false,
            writable: true,
        }
    );
    assert!(
        !root
            .path()
            .join("data/credentials/credentials.json")
            .exists()
    );
}

#[test]
fn secret_values_never_appear_in_debug_output() {
    let root = TempRoot::new("debug");
    let home = home(&root);
    let mut credentials = Credentials::new(home).expect("create credentials");

    credentials
        .replace(&[("AIO_PROFILE_ONE", "debug-secret")])
        .expect("replace credential");
    let resolved = credentials
        .resolve("AIO_PROFILE_ONE")
        .expect("resolve credential")
        .expect("credential");

    assert!(!format!("{credentials:?}").contains("debug-secret"));
    assert!(!format!("{resolved:?}").contains("debug-secret"));
}

#[test]
fn invalid_refs_are_rejected() {
    let root = TempRoot::new("invalid");
    let credentials = Credentials::new(home(&root)).expect("create credentials");

    for value in ["", "AIO PROFILE", "1AIO_PROFILE", "../escape"] {
        assert!(credentials.resolve(value).is_err(), "{value} was accepted");
    }
}

#[cfg(unix)]
#[test]
fn document_and_parent_directory_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let root = TempRoot::new("modes");
    let home = home(&root);
    let mut credentials = Credentials::new(home).expect("create credentials");
    credentials
        .replace(&[("AIO_PROFILE_ONE", "secret")])
        .expect("replace credential");

    let mode = fs::metadata(root.path().join("data/credentials/credentials.json"))
        .expect("credential metadata")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600);
}
