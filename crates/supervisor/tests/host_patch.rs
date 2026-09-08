use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use aio_dsh_supervisor::materialize_host_patch;

#[test]
fn materializes_a_file_url_without_executable_yaml() {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "aio-dsh-host-patch-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&root).expect("create root");
    let template = root.join("template.yml");
    let output = root.join("managed/cordis.patch.yml");
    fs::write(
        &template,
        "- insert:\n    - id: host\n      name: __AIO_DSH_HOST_MODULE__\n",
    )
    .expect("write template");

    materialize_host_patch(
        &template,
        &output,
        &PathBuf::from(r"C:\Program Files\AIO's Host\aio-dsh-host.mjs"),
    )
    .expect("materialize patch");

    let rendered = fs::read_to_string(&output).expect("read output");
    assert!(
        rendered.contains("name: 'file:///C:/Program%20Files/AIO%27s%20Host/aio-dsh-host.mjs'")
    );
    assert!(!rendered.contains("__AIO_DSH_HOST_MODULE__"));
    assert!(!rendered.contains("!!js"));
    let _ = fs::remove_dir_all(root);
}
