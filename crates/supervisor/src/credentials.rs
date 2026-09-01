use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::DshHomeLayout;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialInfo {
    pub configured: bool,
    pub writable: bool,
}

#[derive(Clone)]
pub struct Credential {
    value: String,
}

impl Credential {
    pub fn value(&self) -> Option<&str> {
        Some(&self.value)
    }
}

impl fmt::Debug for Credential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Credential")
            .field("value", &"<redacted>")
            .finish()
    }
}

pub struct Credentials {
    path: PathBuf,
    entries: BTreeMap<String, String>,
}

impl Credentials {
    pub fn new(home: DshHomeLayout) -> Result<Self, CredentialError> {
        let path = home.credentials_dir().join("credentials.json");
        let entries = if path.exists() {
            let bytes = fs::read(&path)?;
            serde_json::from_slice::<CredentialDocument>(&bytes)?.credentials
        } else {
            BTreeMap::new()
        };
        Ok(Self { path, entries })
    }

    pub fn replace(&mut self, entries: &[(&str, &str)]) -> Result<(), CredentialError> {
        let mut next = BTreeMap::new();
        for (key, value) in entries {
            validate_ref(key)?;
            next.insert((*key).to_owned(), (*value).to_owned());
        }

        if next.is_empty() {
            if self.path.exists() {
                fs::remove_file(&self.path)?;
            }
            self.entries = next;
            return Ok(());
        }

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
            apply_directory_mode(parent)?;
        }

        let temp = self.path.with_extension("json.tmp");
        let document = CredentialDocument {
            credentials: next.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&document)?;
        if temp.exists() {
            fs::remove_file(&temp)?;
        }
        write_secret_file(&temp, &bytes)?;
        fs::rename(&temp, &self.path)?;
        apply_secret_mode(&self.path)?;
        self.entries = next;
        Ok(())
    }

    pub fn clear(&mut self) -> Result<(), CredentialError> {
        self.replace(&[])
    }

    pub fn resolve(&self, key: &str) -> Result<Option<Credential>, CredentialError> {
        validate_ref(key)?;
        Ok(self.entries.get(key).map(|value| Credential {
            value: value.clone(),
        }))
    }

    pub fn describe(&self, key: &str) -> Result<CredentialInfo, CredentialError> {
        validate_ref(key)?;
        Ok(CredentialInfo {
            configured: self.entries.contains_key(key),
            writable: true,
        })
    }
}

impl fmt::Debug for Credentials {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Credentials")
            .field("path", &self.path)
            .field("refs", &self.entries.keys().collect::<Vec<_>>())
            .finish()
    }
}

#[derive(Debug, Error)]
pub enum CredentialError {
    #[error("invalid credential ref: {0}")]
    InvalidRef(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Serialize, Deserialize)]
struct CredentialDocument {
    credentials: BTreeMap<String, String>,
}

fn validate_ref(value: &str) -> Result<(), CredentialError> {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_uppercase() => {}
        _ => return Err(CredentialError::InvalidRef(value.to_owned())),
    }
    if chars.all(|char| char.is_ascii_uppercase() || char.is_ascii_digit() || char == '_') {
        Ok(())
    } else {
        Err(CredentialError::InvalidRef(value.to_owned()))
    }
}

fn write_secret_file(path: &PathBuf, bytes: &[u8]) -> Result<(), CredentialError> {
    #[cfg(unix)]
    let mut file = {
        use std::os::unix::fs::OpenOptionsExt;

        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?
    };

    #[cfg(not(unix))]
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;

    file.write_all(bytes)?;
    file.sync_all()?;
    apply_secret_mode(path)?;
    Ok(())
}

#[cfg(unix)]
fn apply_directory_mode(path: &std::path::Path) -> Result<(), CredentialError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn apply_directory_mode(_path: &std::path::Path) -> Result<(), CredentialError> {
    Ok(())
}

#[cfg(unix)]
fn apply_secret_mode(path: &std::path::Path) -> Result<(), CredentialError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn apply_secret_mode(_path: &std::path::Path) -> Result<(), CredentialError> {
    Ok(())
}
