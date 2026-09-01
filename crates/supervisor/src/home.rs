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

    pub fn credentials_dir(&self) -> &Path {
        &self.credentials_dir
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
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
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
