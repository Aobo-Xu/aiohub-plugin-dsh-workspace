use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path};

use serde::Deserialize;
use thiserror::Error;

pub const DSH_CONTRACT_HASH: &str =
    "96af8af6cdb538da2cd13c53eb4dd640f0ca233aab68b209d82fc744e01da519";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlatformTarget {
    Win32X64,
    LinuxX64,
    DarwinArm64,
    LinuxArm64,
}

impl PlatformTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Win32X64 => "win32-x64",
            Self::LinuxX64 => "linux-x64",
            Self::DarwinArm64 => "darwin-arm64",
            Self::LinuxArm64 => "linux-arm64",
        }
    }
}

impl TryFrom<&str> for PlatformTarget {
    type Error = RuntimeValidationError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "win32-x64" => Ok(Self::Win32X64),
            "linux-x64" => Ok(Self::LinuxX64),
            "darwin-arm64" => Ok(Self::DarwinArm64),
            "linux-arm64" => Ok(Self::LinuxArm64),
            _ => Err(RuntimeValidationError::Platform(format!(
                "unsupported platform {value}"
            ))),
        }
    }
}

pub trait RuntimePlatform {
    fn resolve(self) -> Result<PlatformTarget, RuntimeValidationError>;
}

impl RuntimePlatform for PlatformTarget {
    fn resolve(self) -> Result<PlatformTarget, RuntimeValidationError> {
        Ok(self)
    }
}

impl RuntimePlatform for &str {
    fn resolve(self) -> Result<PlatformTarget, RuntimeValidationError> {
        PlatformTarget::try_from(self)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLockV1 {
    pub schema_version: u32,
    pub version: String,
    pub tag: String,
    pub commit: String,
    #[serde(default)]
    pub published_at: Option<String>,
    pub source: RuntimeSource,
    #[serde(default)]
    pub official_wheel: Option<OfficialWheel>,
    #[serde(default)]
    pub license: Option<String>,
    pub license_result: LicenseResult,
    #[serde(default)]
    pub cyclonedx_path: Option<String>,
    pub profile_version: String,
    pub contract_hash: String,
    pub aio_semver_range: String,
    pub toolchain: RuntimeToolchain,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub platforms: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeToolchain {
    pub node: String,
    pub pnpm: String,
    pub python: String,
    pub rust: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeSource {
    pub kind: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialWheel {
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseResult {
    #[serde(default)]
    pub spdx: String,
}

#[derive(Clone, Debug)]
pub struct ValidatedRuntime {
    platform: PlatformTarget,
}

impl ValidatedRuntime {
    pub fn architecture(&self) -> &'static str {
        match self.platform {
            PlatformTarget::Win32X64 | PlatformTarget::LinuxX64 => "x64",
            PlatformTarget::DarwinArm64 | PlatformTarget::LinuxArm64 => "arm64",
        }
    }

    pub fn validate_layout(
        &self,
        runtime_root: &Path,
        files: &[&str],
    ) -> Result<(), RuntimeValidationError> {
        validate_layout_against_root(runtime_root, files)
    }
}

#[derive(Debug, Error)]
pub enum RuntimeValidationError {
    #[error("runtime lock is invalid: {0}")]
    Lock(String),
    #[error("runtime platform invalid: {0}")]
    Platform(String),
    #[error("runtime path escapes its root: {0}")]
    PathEscape(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Default)]
pub struct RuntimeValidator;

impl RuntimeValidator {
    pub fn validate(
        lock_path: &Path,
        platform: impl RuntimePlatform,
    ) -> Result<ValidatedRuntime, RuntimeValidationError> {
        let platform = platform.resolve()?;
        let raw = fs::read(lock_path)?;
        let lock: RuntimeLockV1 = serde_json::from_slice(&raw)
            .map_err(|error| RuntimeValidationError::Lock(error.to_string()))?;

        if lock.schema_version != 1
            || lock.version.is_empty()
            || lock.tag != format!("dsh-v{}", lock.version)
            || lock.commit.len() != 40
            || !lock
                .commit
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        {
            return Err(RuntimeValidationError::Lock(
                "release identity is not fully pinned".to_owned(),
            ));
        }
        if lock.contract_hash != DSH_CONTRACT_HASH {
            return Err(RuntimeValidationError::Lock(
                "contract hash mismatch".to_owned(),
            ));
        }
        if lock.profile_version != "dsh-runtime-profile-v1" {
            return Err(RuntimeValidationError::Lock(
                "profile version mismatch".to_owned(),
            ));
        }
        if lock.aio_semver_range != ">=0.7.0-alpha.4" {
            return Err(RuntimeValidationError::Lock(
                "AIO compatibility range mismatch".to_owned(),
            ));
        }

        validate_toolchain(&lock)?;
        validate_source(&lock)?;

        if lock.license_result.spdx.parse::<Spdx>().is_err() {
            return Err(RuntimeValidationError::Lock(format!(
                "unsupported license {:?}",
                lock.license_result.spdx
            )));
        }
        if !lock.platforms.contains_key(platform.as_str())
            && lock.platform.as_deref() != Some(platform.as_str())
        {
            return Err(RuntimeValidationError::Platform(
                platform.as_str().to_owned(),
            ));
        }

        Ok(ValidatedRuntime { platform })
    }
}

#[derive(Debug)]
struct Spdx;

impl std::str::FromStr for Spdx {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "MIT" | "Apache-2.0" => Ok(Self),
            _ => Err(()),
        }
    }
}

fn validate_layout_against_root(
    runtime_root: &Path,
    files: &[&str],
) -> Result<(), RuntimeValidationError> {
    let canonical_root = runtime_root.canonicalize()?;
    for &file in files {
        let relative = Path::new(file);
        if relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(RuntimeValidationError::PathEscape(file.to_owned()));
        }

        let candidate = canonical_root.join(relative);
        let canonical = candidate.canonicalize()?;
        if !canonical.starts_with(&canonical_root) {
            return Err(RuntimeValidationError::PathEscape(file.to_owned()));
        }
        if !canonical.is_file() {
            return Err(RuntimeValidationError::Lock(format!(
                "runtime file missing: {file}"
            )));
        }
    }
    Ok(())
}

fn validate_toolchain(lock: &RuntimeLockV1) -> Result<(), RuntimeValidationError> {
    if lock.toolchain.node != "not-applicable"
        || lock.toolchain.pnpm != "not-applicable"
        || lock.toolchain.python != "3.10"
        || lock.toolchain.rust != "not-applicable"
    {
        return Err(RuntimeValidationError::Lock(
            "toolchain is not pinned".to_owned(),
        ));
    }
    Ok(())
}

fn validate_source(lock: &RuntimeLockV1) -> Result<(), RuntimeValidationError> {
    if lock.source.kind != "official-wheel"
        || !lock
            .source
            .url
            .starts_with("https://files.pythonhosted.org/")
        || lock.source.sha256.len() != 64
        || !lock
            .source
            .sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(RuntimeValidationError::Lock(
            "runtime source is not a pinned official wheel".to_owned(),
        ));
    }
    Ok(())
}
