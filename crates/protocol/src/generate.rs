use std::collections::BTreeMap;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use aio_dsh_protocol::ProtocolSchema;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

struct Artifact {
    relative_path: &'static str,
    bytes: Vec<u8>,
}

struct Options {
    check: bool,
    output_root: PathBuf,
}

trait CommitHook {
    fn before_replace(&mut self, index: usize, path: &Path) -> Result<(), String>;
}

struct NoopCommitHook;

static NEXT_STAGING_DIRECTORY: AtomicU64 = AtomicU64::new(0);

impl CommitHook for NoopCommitHook {
    fn before_replace(&mut self, _index: usize, _path: &Path) -> Result<(), String> {
        Ok(())
    }
}

fn main() {
    if let Err(message) = run() {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let options = parse_options(env::args().skip(1))?;
    let artifacts = generated_artifacts()?;

    if options.check {
        let drifted = artifacts
            .iter()
            .filter_map(|artifact| {
                let path = options.output_root.join(artifact.relative_path);
                match fs::read(path) {
                    Ok(current) if current == artifact.bytes => None,
                    _ => Some(artifact.relative_path),
                }
            })
            .collect::<Vec<_>>();
        if drifted.is_empty() {
            return Ok(());
        }
        return Err(format!(
            "generated protocol drift: {}\nrun `bun run generate:protocol` to refresh artifacts",
            drifted.join(", ")
        ));
    }

    write_artifacts(&options.output_root, &artifacts)
}

fn parse_options(arguments: impl IntoIterator<Item = String>) -> Result<Options, String> {
    let default_output_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "protocol crate is not nested under the repository root".to_owned())?
        .to_path_buf();
    let mut check = false;
    let mut output_root = None;
    let mut arguments = arguments.into_iter();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--check" if !check => check = true,
            "--output-root" if output_root.is_none() => {
                let value = arguments.next().ok_or_else(|| {
                    "usage: generate [--check] [--output-root PATH]; --output-root requires PATH"
                        .to_owned()
                })?;
                output_root = Some(PathBuf::from(value));
            }
            _ => {
                return Err(format!(
                    "usage: generate [--check] [--output-root PATH]; unexpected argument: {argument:?}"
                ));
            }
        }
    }
    Ok(Options {
        check,
        output_root: output_root.unwrap_or(default_output_root),
    })
}

fn generated_artifacts() -> Result<[Artifact; 3], String> {
    let schema = schemars::schema_for!(ProtocolSchema);
    let canonical_schema = canonicalize(
        serde_json::to_value(schema).map_err(|error| format!("serialize schema: {error}"))?,
    );
    let mut schema_bytes = serde_json::to_vec(&canonical_schema)
        .map_err(|error| format!("encode canonical schema: {error}"))?;
    schema_bytes.push(b'\n');

    let contract_hash = format!("{:x}", Sha256::digest(&schema_bytes));
    let declarations = typescript_declarations(&canonical_schema, &contract_hash)?;

    Ok([
        Artifact {
            relative_path: "generated/protocol.schema.json",
            bytes: schema_bytes,
        },
        Artifact {
            relative_path: "generated/protocol.d.ts",
            bytes: declarations.into_bytes(),
        },
        Artifact {
            relative_path: "generated/protocol.sha256",
            bytes: contract_hash.into_bytes(),
        },
    ])
}

fn write_artifacts(output_root: &Path, artifacts: &[Artifact]) -> Result<(), String> {
    write_artifacts_with_hook(output_root, artifacts, &mut NoopCommitHook)
}

fn write_artifacts_with_hook(
    output_root: &Path,
    artifacts: &[Artifact],
    hook: &mut dyn CommitHook,
) -> Result<(), String> {
    if artifacts.last().map(|artifact| artifact.relative_path) != Some("generated/protocol.sha256")
    {
        return Err("protocol hash must be the final commit marker".to_owned());
    }

    let _writer_lock = WriterLock::acquire(output_root)?;
    let staging = StagingDirectory::create(output_root)?;
    let staged = stage_artifacts(output_root, &staging.path, artifacts)?;
    commit_staged_artifacts(&staged, hook)
}

fn canonicalize(value: Value) -> Value {
    match value {
        Value::Object(object) => {
            let sorted = object
                .into_iter()
                .map(|(key, value)| (key, canonicalize(value)))
                .collect::<BTreeMap<_, _>>();
            Value::Object(sorted.into_iter().collect::<Map<_, _>>())
        }
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize).collect()),
        primitive => primitive,
    }
}

fn typescript_declarations(schema: &Value, contract_hash: &str) -> Result<String, String> {
    let definitions = schema
        .get("$defs")
        .and_then(Value::as_object)
        .ok_or_else(|| "protocol schema is missing $defs".to_owned())?;
    let root_name = schema
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("ProtocolSchema");

    let mut output =
        String::from("/* This file is generated by aio-dsh-protocol. Do not edit. */\n\n");
    output.push_str(&format!(
        "export const CONTRACT_HASH = \"{contract_hash}\";\n\n"
    ));
    for (name, definition) in definitions {
        output.push_str(&format!(
            "export type {} = {};\n\n",
            type_name(name),
            ts_type(definition, 0)?
        ));
    }
    output.push_str(&format!(
        "export type {} = {};\n",
        type_name(root_name),
        ts_type(schema, 0)?
    ));
    Ok(output)
}

fn ts_type(schema: &Value, indent: usize) -> Result<String, String> {
    match schema {
        Value::Bool(true) => return Ok("unknown".to_owned()),
        Value::Bool(false) => return Ok("never".to_owned()),
        Value::Object(_) => {}
        _ => return Err("schema node must be an object or boolean".to_owned()),
    }

    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        let name = reference
            .strip_prefix("#/$defs/")
            .ok_or_else(|| format!("unsupported schema reference {reference:?}"))?;
        return Ok(type_name(name));
    }
    if let Some(value) = schema.get("const") {
        return ts_literal(value);
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        return join_schema_types(values.iter().map(ts_literal), " | ");
    }
    for (keyword, separator) in [("oneOf", " | "), ("anyOf", " | "), ("allOf", " & ")] {
        if let Some(variants) = schema.get(keyword).and_then(Value::as_array) {
            return join_schema_types(
                variants
                    .iter()
                    .map(|variant| ts_type(variant, indent).map(parenthesize_composite)),
                separator,
            );
        }
    }

    match schema.get("type") {
        Some(Value::Array(types)) => join_schema_types(
            types.iter().map(|value| {
                ts_type(
                    &Value::Object(Map::from_iter([("type".to_owned(), value.clone())])),
                    indent,
                )
            }),
            " | ",
        ),
        Some(Value::String(kind)) => match kind.as_str() {
            "null" => Ok("null".to_owned()),
            "boolean" => Ok("boolean".to_owned()),
            "integer" | "number" => Ok("number".to_owned()),
            "string" => Ok("string".to_owned()),
            "array" => {
                let item = schema.get("items").unwrap_or(&Value::Bool(true));
                Ok(format!("Array<{}>", ts_type(item, indent)?))
            }
            "object" => ts_object(schema, indent),
            unsupported => Err(format!("unsupported JSON Schema type {unsupported:?}")),
        },
        None if schema.get("properties").is_some()
            || schema.get("additionalProperties").is_some() =>
        {
            ts_object(schema, indent)
        }
        None => Ok("unknown".to_owned()),
        Some(other) => Err(format!("invalid JSON Schema type {other}")),
    }
}

fn ts_object(schema: &Value, indent: usize) -> Result<String, String> {
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let required = schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    let next_indent = indent + 2;
    let padding = " ".repeat(next_indent);
    let closing_padding = " ".repeat(indent);
    let mut members = Vec::new();

    for (name, property_schema) in properties {
        let optional = if required.contains(name.as_str()) {
            ""
        } else {
            "?"
        };
        members.push(format!(
            "{padding}{}{optional}: {};",
            property_name(&name),
            ts_type(&property_schema, next_indent)?
        ));
    }

    match schema.get("additionalProperties") {
        Some(Value::Bool(false)) | None if !members.is_empty() => {}
        Some(Value::Bool(false)) => {}
        Some(Value::Bool(true)) | None => {
            members.push(format!("{padding}[key: string]: unknown;"));
        }
        Some(additional) => members.push(format!(
            "{padding}[key: string]: {};",
            ts_type(additional, next_indent)?
        )),
    }

    if members.is_empty() {
        return Ok("Record<string, never>".to_owned());
    }
    Ok(format!("{{\n{}\n{closing_padding}}}", members.join("\n")))
}

fn ts_literal(value: &Value) -> Result<String, String> {
    match value {
        Value::Null => Ok("null".to_owned()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(value) => Ok(value.to_string()),
        Value::String(value) => serde_json::to_string(value)
            .map_err(|error| format!("encode TypeScript string literal: {error}")),
        _ => Err(format!("unsupported TypeScript literal {value}")),
    }
}

fn join_schema_types<I>(types: I, separator: &str) -> Result<String, String>
where
    I: IntoIterator<Item = Result<String, String>>,
{
    let values = types.into_iter().collect::<Result<Vec<_>, _>>()?;
    if values.is_empty() {
        Ok("never".to_owned())
    } else {
        Ok(values.join(separator))
    }
}

fn parenthesize_composite(value: String) -> String {
    if value.contains('\n') || value.contains(" | ") || value.contains(" & ") {
        format!("({value})")
    } else {
        value
    }
}

fn type_name(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn property_name(value: &str) -> String {
    let mut characters = value.chars();
    let is_identifier = characters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_');
    if is_identifier {
        value.to_owned()
    } else {
        serde_json::to_string(value).expect("JSON property names are serializable")
    }
}

struct WriterLock {
    file: fs::File,
}

impl WriterLock {
    fn acquire(output_root: &Path) -> Result<Self, String> {
        let lock_directory = output_root.join("target");
        fs::create_dir_all(&lock_directory).map_err(|error| {
            format!(
                "create protocol writer lock directory {}: {error}",
                lock_directory.display()
            )
        })?;
        let lock_path = lock_directory.join("aio-dsh-protocol-generate.lock");
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .map_err(|error| {
                format!("open protocol writer lock {}: {error}", lock_path.display())
            })?;
        file.lock()
            .map_err(|error| format!("lock protocol writer {}: {error}", lock_path.display()))?;
        Ok(Self { file })
    }
}

impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

struct StagingDirectory {
    path: PathBuf,
}

impl StagingDirectory {
    fn create(output_root: &Path) -> Result<Self, String> {
        let generated_directory = output_root.join("generated");
        fs::create_dir_all(&generated_directory).map_err(|error| {
            format!(
                "create generated directory {}: {error}",
                generated_directory.display()
            )
        })?;
        loop {
            let sequence = NEXT_STAGING_DIRECTORY.fetch_add(1, Ordering::Relaxed);
            let path = generated_directory.join(format!(
                ".protocol-staging-{}-{sequence}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self { path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!(
                        "create unique protocol staging directory {}: {error}",
                        path.display()
                    ));
                }
            }
        }
    }
}

impl Drop for StagingDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

struct StagedArtifact {
    target: PathBuf,
    replacement: PathBuf,
    backup: Option<PathBuf>,
}

fn stage_artifacts(
    output_root: &Path,
    staging_directory: &Path,
    artifacts: &[Artifact],
) -> Result<Vec<StagedArtifact>, String> {
    artifacts
        .iter()
        .enumerate()
        .map(|(index, artifact)| {
            let target = output_root.join(artifact.relative_path);
            let replacement = staging_directory.join(format!("{index}.new"));
            write_synced_file(&replacement, &artifact.bytes)?;
            let backup = match fs::read(&target) {
                Ok(bytes) => {
                    let path = staging_directory.join(format!("{index}.old"));
                    write_synced_file(&path, &bytes)?;
                    Some(path)
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => {
                    return Err(format!(
                        "read existing generated artifact {}: {error}",
                        target.display()
                    ));
                }
            };
            Ok(StagedArtifact {
                target,
                replacement,
                backup,
            })
        })
        .collect()
}

fn write_synced_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("create staged artifact {}: {error}", path.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("write staged artifact {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("sync staged artifact {}: {error}", path.display()))
}

fn commit_staged_artifacts(
    artifacts: &[StagedArtifact],
    hook: &mut dyn CommitHook,
) -> Result<(), String> {
    let mut committed = Vec::new();
    for (index, artifact) in artifacts.iter().enumerate() {
        let result = hook.before_replace(index, &artifact.target).and_then(|()| {
            fs::rename(&artifact.replacement, &artifact.target).map_err(|error| {
                format!(
                    "replace generated artifact {}: {error}",
                    artifact.target.display()
                )
            })
        });
        if let Err(commit_error) = result {
            return match rollback_artifacts(artifacts, &committed) {
                Ok(()) => Err(commit_error),
                Err(rollback_error) => Err(format!(
                    "{commit_error}; protocol artifact rollback also failed: {rollback_error}"
                )),
            };
        }
        committed.push(index);
    }
    Ok(())
}

fn rollback_artifacts(artifacts: &[StagedArtifact], committed: &[usize]) -> Result<(), String> {
    let mut failures = Vec::new();
    for index in committed.iter().rev().copied() {
        let artifact = &artifacts[index];
        let result = if let Some(backup) = &artifact.backup {
            fs::rename(backup, &artifact.target)
        } else {
            fs::remove_file(&artifact.target)
        };
        if let Err(error) = result {
            failures.push(format!("{}: {error}", artifact.target.display()));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Barrier};
    use std::thread;

    use super::*;

    static NEXT_TEST_ROOT: AtomicU64 = AtomicU64::new(0);

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new(label: &str) -> Self {
            let path = env::temp_dir().join(format!(
                "aio-dsh-protocol-{label}-{}-{}",
                std::process::id(),
                NEXT_TEST_ROOT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).expect("create test root");
            Self(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct FailBeforeReplace(usize);

    impl CommitHook for FailBeforeReplace {
        fn before_replace(&mut self, index: usize, _path: &Path) -> Result<(), String> {
            if index == self.0 {
                Err(format!("injected commit failure before artifact {index}"))
            } else {
                Ok(())
            }
        }
    }

    fn test_artifacts(marker: u8, size: usize) -> [Artifact; 3] {
        [
            Artifact {
                relative_path: "generated/protocol.schema.json",
                bytes: vec![marker; size],
            },
            Artifact {
                relative_path: "generated/protocol.d.ts",
                bytes: vec![marker; size],
            },
            Artifact {
                relative_path: "generated/protocol.sha256",
                bytes: vec![marker; 64],
            },
        ]
    }

    fn seed_artifacts(root: &Path, artifacts: &[Artifact]) {
        for artifact in artifacts {
            let path = root.join(artifact.relative_path);
            fs::create_dir_all(path.parent().expect("artifact parent"))
                .expect("create artifact parent");
            fs::write(path, &artifact.bytes).expect("seed artifact");
        }
    }

    #[test]
    fn artifact_transaction_rolls_back_a_failure_between_replacements() {
        let root = TestRoot::new("rollback");
        let original = test_artifacts(b'o', 32);
        let replacement = test_artifacts(b'n', 32);
        seed_artifacts(&root.0, &original);

        let error = write_artifacts_with_hook(&root.0, &replacement, &mut FailBeforeReplace(2))
            .expect_err("injected failure must abort generation");

        assert!(error.contains("injected commit failure"));
        for artifact in original {
            assert_eq!(
                fs::read(root.0.join(artifact.relative_path)).expect("read rolled back artifact"),
                artifact.bytes
            );
        }
    }

    #[test]
    fn concurrent_writers_finish_with_one_complete_artifact_set() {
        let root_guard = TestRoot::new("concurrent");
        let root = Arc::new(root_guard.0.clone());
        let barrier = Arc::new(Barrier::new(6));
        let handles = (b'a'..=b'f')
            .map(|marker| {
                let root = Arc::clone(&root);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    let artifacts = test_artifacts(marker, 2 * 1024 * 1024);
                    barrier.wait();
                    write_artifacts(&root, &artifacts)
                })
            })
            .collect::<Vec<_>>();

        let results = handles
            .into_iter()
            .map(|handle| handle.join().expect("writer thread"))
            .collect::<Vec<_>>();
        assert!(
            results.iter().all(Result::is_ok),
            "concurrent writer errors: {results:?}"
        );

        let final_markers = [
            "generated/protocol.schema.json",
            "generated/protocol.d.ts",
            "generated/protocol.sha256",
        ]
        .map(|relative_path| {
            fs::read(root.join(relative_path))
                .expect("read final artifact")
                .first()
                .copied()
                .expect("non-empty artifact")
        });
        assert!(
            final_markers
                .iter()
                .all(|marker| *marker == final_markers[0]),
            "mixed concurrent artifact set: {final_markers:?}"
        );
    }
}
