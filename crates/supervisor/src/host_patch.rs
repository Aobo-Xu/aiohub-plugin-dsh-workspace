use std::fs;
use std::io;
use std::path::Path;

const PLACEHOLDER: &str = "__AIO_DSH_HOST_MODULE__";

pub fn materialize_host_patch(
    template_path: &Path,
    output_path: &Path,
    host_module: &Path,
) -> io::Result<()> {
    let template = fs::read_to_string(template_path)?;
    if !template.contains(PLACEHOLDER) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Host patch template placeholder is missing",
        ));
    }
    let module_url = path_to_file_url(host_module)?;
    let rendered = template.replace(PLACEHOLDER, &format!("'{module_url}'"));
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(output_path, rendered)
}

fn path_to_file_url(path: &Path) -> io::Result<String> {
    let raw = path
        .to_str()
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "Host module path is not UTF-8")
        })?
        .replace('\\', "/");
    let prefix = if raw.as_bytes().get(1) == Some(&b':') {
        "file:///"
    } else if raw.starts_with('/') {
        "file://"
    } else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Host module path must be absolute",
        ));
    };
    Ok(format!("{prefix}{}", percent_encode_path(&raw)))
}

fn percent_encode_path(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'.' | b'_' | b'~' | b'/' | b':')
        {
            encoded.push(char::from(*byte));
        } else {
            use std::fmt::Write as _;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}
