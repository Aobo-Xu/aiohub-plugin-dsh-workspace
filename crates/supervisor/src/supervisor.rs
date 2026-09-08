use std::collections::BTreeSet;
use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use aio_dsh_protocol::{
    CommandEnvelope, CommandPayload, Envelope, InitializeRequest, InitializeResult, PongResult,
    ResponseEnvelope, ResponsePayload, RuntimeProvenance, negotiate_initialize,
};
use thiserror::Error;

use crate::home::{DshHomeLayout, HomeError};
use crate::process::{
    ManagedHostProcess, ManagedProcess, ProcessBackend, ProcessPolicy, SpawnSpec,
};
use crate::runtime::{DSH_CONTRACT_HASH, PlatformTarget, RuntimeValidationError, RuntimeValidator};

const SUPERVISOR_CAPABILITIES: &[&str] = &["session", "snapshot"];
const SUPPORTED_HOST_API_VERSION: u16 = 3;

#[derive(Clone)]
pub struct SupervisorConfig {
    pub plugin_data_dir: PathBuf,
    pub runtime_lock_path: PathBuf,
    pub runtime_root: PathBuf,
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SupervisorOwner {
    #[default]
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
    pub fail_at_child_settlement: bool,
    pub fail_at_protocol: bool,
    pub child: Option<SpawnSpec>,
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
    #[error("supervisor configuration invalid: {0}")]
    Config(String),
    #[error("supervisor state poisoned")]
    StatePoisoned,
    #[error("initialization failed at step {step}")]
    Startup { step: &'static str },
}

pub struct Supervisor {
    config: SupervisorConfig,
    backend: ProcessBackend,
    state: Mutex<SupervisorState>,
}

#[derive(Default)]
struct SupervisorState {
    owner: SupervisorOwner,
    home: Option<DshHomeLayout>,
    child: Option<ManagedProcess>,
    host: Option<ManagedHostProcess>,
}

impl Supervisor {
    pub fn new(config: SupervisorConfig) -> Result<Self, SupervisorError> {
        Self::validate_config(&config)?;
        let backend = ProcessBackend::create()?;
        let supervisor = Self {
            config,
            backend,
            state: Mutex::new(SupervisorState::default()),
        };

        if supervisor.config.prewarm {
            supervisor.startup_transaction(&StartupFlags::default())?;
        }

        Ok(supervisor)
    }

    pub fn owner(&self) -> SupervisorOwner {
        self.state
            .lock()
            .map_err(|_| SupervisorError::StatePoisoned)
            .map(|state| state.owner)
            .unwrap_or(SupervisorOwner::Unavailable)
    }

    /// The platform target this supervisor was configured for; the driver
    /// reads it once when constructing its stdio loop state.
    pub fn platform(&self) -> PlatformTarget {
        self.config.platform
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
        let result = negotiate_initialize(&local, &remote);
        if result.is_err() {
            self.rollback_startup()?;
        }
        Ok(result?)
    }

    pub fn startup_transaction(&self, flags: &StartupFlags) -> Result<(), SupervisorError> {
        let mut state = self.lock_state()?;
        if matches!(state.owner, SupervisorOwner::Ready | SupervisorOwner::Busy) {
            return Ok(());
        }
        state.owner = SupervisorOwner::Starting;

        match self.execute_startup_transaction(flags, &mut state) {
            Ok(()) => {
                state.owner = SupervisorOwner::Ready;
                Ok(())
            }
            Err(error) => {
                state.owner = SupervisorOwner::Stopped;
                Err(error)
            }
        }
    }

    pub fn validate_runtime_layout(&self, files: &[&str]) -> Result<(), SupervisorError> {
        let validated =
            RuntimeValidator::validate(&self.config.runtime_lock_path, self.config.platform)?;
        validated.validate_layout(&self.config.runtime_root, files)?;
        Ok(())
    }

    fn execute_startup_transaction(
        &self,
        flags: &StartupFlags,
        state: &mut SupervisorState,
    ) -> Result<(), SupervisorError> {
        Self::validate_config(&self.config)?;
        RuntimeValidator::validate(&self.config.runtime_lock_path, self.config.platform)?;
        let home = DshHomeLayout::create(&self.config.plugin_data_dir)?;

        if flags.fail_at_credentials {
            home.remove()?;
            return Err(SupervisorError::Startup {
                step: "credentials",
            });
        }

        let mut child = None;
        if let Some(mut spec) = flags.child.clone() {
            home.apply_environment(&mut spec.env);
            child = Some(self.backend.spawn(spec)?);
        }

        if flags.fail_at_child_settlement {
            if let Some(process) = child.as_mut() {
                self.backend
                    .terminate_tree(process, ProcessPolicy::default().terminate_grace)?;
            }
            home.remove()?;
            return Err(SupervisorError::Startup {
                step: "child-settlement",
            });
        }

        let local = self.local_initialize_request();
        if flags.fail_at_protocol {
            if let Some(process) = child.as_mut() {
                self.backend
                    .terminate_tree(process, ProcessPolicy::default().terminate_grace)?;
            }
            home.remove()?;
            return Err(SupervisorError::Startup {
                step: "protocol-initialization",
            });
        }
        negotiate_initialize(&local, &local)?;

        state.home = Some(home);
        state.child = child;
        Ok(())
    }

    fn rollback_startup(&self) -> Result<(), SupervisorError> {
        let mut state = self.lock_state()?;
        if let Some(mut host) = state.host.take() {
            self.backend.shutdown_host(&mut host, None)?;
        }
        if let Some(mut child) = state.child.take() {
            self.backend
                .terminate_tree(&mut child, ProcessPolicy::default().terminate_grace)?;
        }
        if let Some(home) = state.home.take() {
            home.remove()?;
        }
        state.owner = SupervisorOwner::Stopped;
        Ok(())
    }

    pub fn host_process_id(&self) -> Option<u32> {
        self.lock_state().ok().and_then(|state| {
            state
                .host
                .as_ref()
                .map(ManagedHostProcess::id)
                .or_else(|| state.child.as_ref().map(ManagedProcess::id))
        })
    }

    pub fn start_host(
        &self,
        mut spec: SpawnSpec,
        initialize_request: &str,
    ) -> Result<String, SupervisorError> {
        let mut state = self.lock_state()?;
        if state.host.is_some() {
            return Err(SupervisorError::Config(
                "managed Host is already running".to_owned(),
            ));
        }
        let home = state
            .home
            .as_ref()
            .ok_or_else(|| SupervisorError::Config("managed Home is not initialized".to_owned()))?;
        home.apply_environment(&mut spec.env);
        let mut host = self.backend.spawn_host(spec)?;
        match host.request_line(initialize_request) {
            Ok(response) => {
                state.host = Some(host);
                Ok(response)
            }
            Err(error) => {
                let _ = self.backend.shutdown_host(&mut host, None);
                Err(SupervisorError::Io(error))
            }
        }
    }

    pub fn host_request(&self, request: &str) -> Result<String, SupervisorError> {
        let mut state = self.lock_state()?;
        let host = state
            .host
            .as_mut()
            .ok_or_else(|| SupervisorError::Config("managed Host is not running".to_owned()))?;
        Ok(host.request_line(request)?)
    }

    pub fn stop_host(&self, shutdown_request: &str) -> Result<(), SupervisorError> {
        let mut state = self.lock_state()?;
        if let Some(mut host) = state.host.take() {
            self.backend
                .shutdown_host(&mut host, Some(shutdown_request))?;
        }
        Ok(())
    }

    pub fn shutdown(&self) -> Result<(), SupervisorError> {
        let mut state = self.lock_state()?;
        state.owner = SupervisorOwner::Stopping;
        if let Some(mut host) = state.host.take() {
            self.backend.shutdown_host(&mut host, None)?;
        }
        if let Some(mut child) = state.child.take() {
            self.backend
                .terminate_tree(&mut child, ProcessPolicy::default().terminate_grace)?;
        }
        state.owner = SupervisorOwner::Stopped;
        Ok(())
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, SupervisorState>, SupervisorError> {
        self.state
            .lock()
            .map_err(|_| SupervisorError::StatePoisoned)
    }

    fn validate_config(config: &SupervisorConfig) -> Result<(), SupervisorError> {
        if config.host_api_version != SUPPORTED_HOST_API_VERSION {
            return Err(SupervisorError::Config(format!(
                "unsupported host API version {}",
                config.host_api_version
            )));
        }
        if config.telemetry_enabled {
            return Err(SupervisorError::Config(
                "telemetry must remain disabled".to_owned(),
            ));
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
