use std::env;
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

const SENTINEL_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn main() {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let source = manifest_dir.join("../../generated/protocol.sha256");
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rustc-check-cfg=cfg(protocol_hash_present)");

    match fs::read_to_string(&source) {
        Ok(value) if is_contract_hash(&value) => {
            println!("cargo:rustc-cfg=protocol_hash_present");
            return;
        }
        Ok(_) => panic!(
            "invalid protocol hash {}: expected exactly 64 lowercase hexadecimal bytes",
            source.display()
        ),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => panic!("read protocol hash {}: {error}", source.display()),
    }

    let output = PathBuf::from(env::var_os("OUT_DIR").expect("out dir")).join("protocol.sha256");
    fs::write(&output, SENTINEL_HASH)
        .unwrap_or_else(|error| panic!("write build protocol hash {}: {error}", output.display()));
}

fn is_contract_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
