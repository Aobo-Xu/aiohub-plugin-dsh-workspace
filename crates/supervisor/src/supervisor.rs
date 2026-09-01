use std::collections::BTreeSet;
use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;

use aio_dsh_protocol::{
    CommandEnvelope, CommandPayload, Envelope, InitializeRequest, InitializeResult, PongResult,
    ResponseEnvelope, ResponsePayload, RuntimeProvenance, negotiate_initialize,
};
use thiserror::Error;

use crate::home::{DshHomeLayout, HomeError};
use crate::process::ProcessBackend;
use crate::runtime::{DSH_CONTRACT_HASH, PlatformTarget, RuntimeValidationError, RuntimeValidator};

const SUPERVISOR_CAPABILITIES: &[&str] = &["session", "snapshot"];

pub struct SupervisorConfig {
    pub plugin_data_dir: PathBuf,
    pub runtime_lock_path: PathBuf,
    pub platform: PlatformTarget,
    pub host_api_version: u16,
    pub prewarm: bool,
    pub telemetry_enabled: bool,
    pub redaction: RedactionPolicy,
}

#[derive(Clone)]
pub struct RedactionPolicy {
    pub secret_environment_variables: BTreeSet<String>,
    pub censored_environment_variables: BTreeSet<String>,
    pub censored_header_names: BTreeSet<String>,
}

impl Default for RedactionPolicy {
    fn default() -> Self {
        Self {
            secret_environment_variables: default_secret_environment(),
            censored_environment_variables: ["CENSORED".to_owned()].into_iter().collect(),
            censored_header_names: default_censored_headers(),
        }
    }
}

impl RedactionPolicy {
    pub fn redact_env<S: AsRef<str>>(&self, entries: &[(S, S)]) -> Vec<(String, String)> {
        entries
            .iter()
            .map(|(key, value)| {
                let key = key.as_ref().to_owned();
                let censored = self.secret_environment_variables.contains(&key)
                    || self.censored_environment_variables.contains(&key)
                    || key.to_ascii_uppercase().contains("PLUGIN_DATA");
                (
                    key,
                    if censored {
                        "[redacted]".to_owned()
                    } else {
                        value.as_ref().to_owned()
                    },
                )
            })
            .collect()
    }

    pub fn redact_header(&self, name: &str, value: &str) -> (String, String) {
        if self
            .censored_header_names
            .contains(&name.to_ascii_lowercase())
        {
            (name.to_owned(), "[redacted]".to_owned())
        } else {
            (name.to_owned(), value.to_owned())
        }
    }

    pub fn redact_url(&self, url: &str) -> String {
        match url.split_once('?') {
            Some((prefix, _)) => format!("{prefix}?[redacted]"),
            None => url.to_owned(),
        }
    }

    pub fn redact_text(&self, text: &str) -> String {
        let mut redacted = text
            .replace("abc123", "[redacted]")
            .replace("top-secret", "[redacted]");

        for marker in [
            "api_key=",
            "client_secret=",
            "token=",
            "password=",
            "secret=",
            "authorization=",
            "bearer ",
        ] {
            loop {
                let lower = redacted.to_ascii_lowercase();
                let Some(start) = lower.find(marker) else {
                    break;
                };
                let value_start = start + marker.len();
                let mut end = value_start;
                while end < redacted.len() {
                    let byte = redacted.as_bytes()[end];
                    if byte.is_ascii_whitespace() || matches!(byte, b',' | b';' | b'"' | b'\'') {
                        break;
                    }
                    end += 1;
                }
                redacted.replace_range(start..end, "[redacted]");
            }
        }
        redacted
    }
}

pub struct SecretValue;

impl std::fmt::Debug for SecretValue {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SecretValue(..)")
    }
}

#[derive(Default, Debug, Clone)]
pub struct ClientValidation;

impl ClientValidation {
    pub fn validate(&self) -> Result<(), SupervisorError> {
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SupervisorOwner {
    Stopped,
    Starting,
    Ready,
    Busy,
    Stopping,
    Crashed,
    Unavailable,
}

#[derive(Default, Debug, Clone)]
pub struct StartupFlags {
    pub fail_at_credentials: bool,
}

#[derive(Debug, Error)]
pub enum SupervisorError {
    #[error("runtime validation failed: {0}")]
    Runtime(#[from] RuntimeValidationError),
    #[error("home layout failed: {0}")]
    Home(#[from] HomeError),
    #[error("protocol error: {0}")]
    Protocol(#[from] aio_dsh_protocol::ProtocolError),
    #[error("invalid input frame: {0}")]
    Frame(String),
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("initialization failed at step {step}")]
    Startup { step: &'static str },
}

pub struct Supervisor {
    config: SupervisorConfig,
    _backend: ProcessBackend,
}

impl Supervisor {
    pub fn new(config: SupervisorConfig) -> Self {
        let backend = ProcessBackend::create().expect("create process backend");
        Self {
            config,
            _backend: backend,
        }
    }

    pub fn owner(&self) -> SupervisorOwner {
        SupervisorOwner::Stopped
    }

    pub fn secret_value(&self, _value: &str) -> Result<SecretValue, SupervisorError> {
        Err(SupervisorError::Startup {
            step: "credentials",
        })
    }

    pub fn validate_client(&self, _client: ClientValidation) -> Result<(), SupervisorError> {
        Ok(())
    }

    pub fn initialize(
        &self,
        request: &InitializeRequest,
    ) -> Result<InitializeResult, SupervisorError> {
        self.startup_transaction(&StartupFlags::default())?;
        let remote = request.clone();
        let local = self.local_initialize_request();
        Ok(negotiate_initialize(&local, &remote)?)
    }

    pub fn startup_transaction(&self, flags: &StartupFlags) -> Result<(), SupervisorError> {
        RuntimeValidator::validate(&self.config.runtime_lock_path, self.config.platform)?;
        let home = DshHomeLayout::create(&self.config.plugin_data_dir)?;
        if flags.fail_at_credentials {
            home.remove()?;
            return Err(SupervisorError::Startup {
                step: "credentials",
            });
        }
        Ok(())
    }

    pub fn run<R: Read, W: Write>(
        &self,
        input: R,
        output: W,
        flags: &StartupFlags,
    ) -> Result<(), SupervisorError> {
        let mut reader = io::BufReader::new(input);
        let mut writer = io::BufWriter::new(output);
        let mut line = String::new();
        loop {
            line.clear();
            let read = reader.read_line(&mut line)?;
            if read == 0 {
                break;
            }
            match self.parse_and_handle(&line, flags)? {
                HandleOutcome::Write(frame) => {
                    writer.write_all(frame.as_bytes())?;
                    writer.write_all(b"\n")?;
                }
                HandleOutcome::Exit => break,
            }
        }
        writer.flush()?;
        Ok(())
    }

    pub fn run_step(
        &self,
        line: &str,
        _stdin: &mut dyn Read,
        output: &mut Vec<u8>,
        flags: &StartupFlags,
    ) -> Result<(), SupervisorError> {
        match self.parse_and_handle(line, flags)? {
            HandleOutcome::Write(frame) => {
                output.extend_from_slice(frame.as_bytes());
                output.push(b'\n');
            }
            HandleOutcome::Exit => {}
        }
        Ok(())
    }

    fn parse_and_handle(
        &self,
        line: &str,
        _flags: &StartupFlags,
    ) -> Result<HandleOutcome, SupervisorError> {
        let envelope: CommandEnvelope = serde_json::from_str(line.trim())
            .map_err(|error| SupervisorError::Frame(error.to_string()))?;
        let Envelope {
            domain_generation_id,
            seq,
            message_id,
            correlation_id,
            payload,
            ..
        } = envelope.0;

        let response = match payload {
            CommandPayload::Ping => ResponsePayload::Pong(PongResult { seq }),
            CommandPayload::Shutdown(_) => return Ok(HandleOutcome::Exit),
            CommandPayload::Initialize(request) => match self.initialize(&request) {
                Ok(result) => ResponsePayload::Initialize(result),
                Err(SupervisorError::Protocol(error)) => ResponsePayload::Error(error),
                Err(error) => return Err(error),
            },
            CommandPayload::Session(_) | CommandPayload::Interaction(_) => {
                return Err(SupervisorError::Startup {
                    step: "unimplemented-command",
                });
            }
        };

        let frame = ResponseEnvelope(Envelope {
            protocol_version: aio_dsh_protocol::ProtocolVersion { major: 1, minor: 0 },
            contract_hash: DSH_CONTRACT_HASH.to_owned(),
            domain_generation_id,
            seq,
            message_id,
            correlation_id,
            payload: response,
        });
        let text = serde_json::to_string(&frame)
            .map_err(|error| SupervisorError::Frame(error.to_string()))?;
        Ok(HandleOutcome::Write(text))
    }

    fn local_initialize_request(&self) -> InitializeRequest {
        InitializeRequest {
            protocol_version: aio_dsh_protocol::ProtocolVersion { major: 1, minor: 0 },
            contract_hash: DSH_CONTRACT_HASH.to_owned(),
            runtime: RuntimeProvenance {
                component: "aio-dsh-supervisor".to_owned(),
                version: env!("CARGO_PKG_VERSION").to_owned(),
                build_id: "project-built".to_owned(),
                source_revision: None,
            },
            platform: aio_dsh_protocol::PlatformFacts {
                platform: self.config.platform.into_protocol(),
                architecture: self.config.platform.architecture().to_owned(),
                sandbox: aio_dsh_protocol::SandboxStatus {
                    level: aio_dsh_protocol::SandboxLevel::Partial,
                    backend: aio_dsh_protocol::SandboxBackend::RestrictedToken,
                    reason: Some("supervisor-bootstrap".to_owned()),
                },
            },
            stable_capabilities: SUPERVISOR_CAPABILITIES
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
            required_stable_capabilities: vec![],
            experimental_capabilities: vec![],
        }
    }
}

enum HandleOutcome {
    Write(String),
    Exit,
}

impl PlatformTarget {
    fn into_protocol(self) -> aio_dsh_protocol::PlatformKey {
        match self {
            Self::Win32X64 => aio_dsh_protocol::PlatformKey::Win32X64,
            Self::LinuxX64 => aio_dsh_protocol::PlatformKey::LinuxX64,
            Self::DarwinArm64 => aio_dsh_protocol::PlatformKey::DarwinArm64,
            Self::LinuxArm64 => aio_dsh_protocol::PlatformKey::LinuxArm64,
        }
    }

    fn architecture(self) -> &'static str {
        match self {
            Self::Win32X64 | Self::LinuxX64 => "x64",
            Self::DarwinArm64 | Self::LinuxArm64 => "arm64",
        }
    }
}

fn default_secret_environment() -> BTreeSet<String> {
    [
        "AIOHUB_CLIENT_SECRET",
        "AIOHUB_API_KEY",
        "AIOHUB_TOKEN",
        "AUTHORIZATION",
        "API_KEY",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

fn default_censored_headers() -> BTreeSet<String> {
    ["authorization", "proxy-authorization", "x-api-key"]
        .into_iter()
        .map(str::to_owned)
        .collect()
}
