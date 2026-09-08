use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use thiserror::Error;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HomeMode {
    pub directory: u32,
    pub secret: u32,
}

impl Default for HomeMode {
    fn default() -> Self {
        Self {
            directory: 0o700,
            secret: 0o600,
        }
    }
}

#[derive(Clone, Debug)]
pub struct DshHomeLayout {
    data: PathBuf,
    data_dir: PathBuf,
    sessions_dir: PathBuf,
    credentials_dir: PathBuf,
    runtime_dir: PathBuf,
    logs_dir: PathBuf,
    temp_dir: PathBuf,
}

impl DshHomeLayout {
    pub fn create(data_dir: &Path) -> Result<Self, HomeError> {
        let mode = HomeMode::default();
        let layout = Self {
            data: data_dir.to_owned(),
            data_dir: data_dir.join("data"),
            sessions_dir: data_dir.join("sessions"),
            credentials_dir: data_dir.join("credentials"),
            runtime_dir: data_dir.join("runtime"),
            logs_dir: data_dir.join("logs"),
            temp_dir: data_dir.join("temp"),
        };
        for entry in layout.entries() {
            fs::create_dir_all(entry)?;
            apply_directory_mode(entry, mode.directory)?;
        }
        Ok(layout)
    }

    pub fn entries(&self) -> [&Path; 6] {
        [
            &self.data_dir,
            &self.sessions_dir,
            &self.credentials_dir,
            &self.runtime_dir,
            &self.logs_dir,
            &self.temp_dir,
        ]
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn root(&self) -> &Path {
        &self.data
    }

    pub fn credentials_dir(&self) -> &Path {
        &self.credentials_dir
    }

    pub fn apply_environment(&self, environment: &mut BTreeMap<String, OsString>) {
        environment.insert("DSH_HOME".to_owned(), self.data.as_os_str().to_owned());
        environment.insert("DSH_TELEMETRY_DISABLED".to_owned(), OsString::from("1"));
    }

    pub fn backup_to(&self, destination: &Path) -> Result<(), HomeError> {
        let source = self.data.canonicalize()?;
        let destination_name = destination
            .file_name()
            .ok_or_else(|| HomeError::UnsupportedEntry(destination.to_owned()))?;
        let destination = destination
            .parent()
            .ok_or_else(|| HomeError::UnsupportedEntry(destination.to_owned()))?
            .canonicalize()?
            .join(destination_name);
        if destination.starts_with(&source) {
            return Err(HomeError::BackupInsideHome(destination));
        }
        if destination.exists() {
            return Err(HomeError::BackupExists(destination.to_owned()));
        }
        copy_managed_tree(&source, &destination)
    }

    pub fn secret_file(&self, name: &str) -> Result<PathBuf, HomeError> {
        if name.contains("..") || name.contains('/') || name.contains('\\') {
            return Err(HomeError::UnsafeName(name.to_owned()));
        }
        Ok(self.credentials_dir.join(name))
    }

    pub fn write_secret(&self, path: &Path, bytes: &[u8]) -> Result<(), HomeError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        #[cfg(unix)]
        let mut file = {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(HomeMode::default().secret)
                .open(path)?
        };

        #[cfg(not(unix))]
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;

        file.write_all(bytes)?;
        Ok(())
    }

    pub fn remove(&self) -> Result<(), HomeError> {
        if self.data.exists() {
            fs::remove_dir_all(&self.data)?;
        }
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum HomeError {
    #[error("unsafe secret file name: {0}")]
    UnsafeName(String),
    #[error("managed home backup destination already exists: {0}")]
    BackupExists(PathBuf),
    #[error("managed home backup destination must be outside the live home: {0}")]
    BackupInsideHome(PathBuf),
    #[error("managed home backup refuses symbolic links or special files: {0}")]
    UnsupportedEntry(PathBuf),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

fn copy_managed_tree(source: &Path, destination: &Path) -> Result<(), HomeError> {
    fs::create_dir(destination)?;
    apply_directory_mode(destination, HomeMode::default().directory)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            return Err(HomeError::UnsupportedEntry(source_path));
        }
        if file_type.is_dir() {
            copy_managed_tree(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path)?;
        } else {
            return Err(HomeError::UnsupportedEntry(source_path));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn apply_directory_mode(path: &Path, mode: u32) -> Result<(), HomeError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    Ok(())
}

#[cfg(not(unix))]
fn apply_directory_mode(_path: &Path, _mode: u32) -> Result<(), HomeError> {
    Ok(())
}
