use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::process::Command;
use std::process::ExitCode;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use aio_dsh_protocol::{
    AcquireSessionRequest, CURRENT_PROTOCOL_VERSION, CancelRequest, CommandAccepted,
    CommandEnvelope, CommandPayload, ControllerLease, Envelope, InteractionDecision,
    InteractionKind, InteractionRequest, InteractionResolutionReason, InteractionResolved,
    InteractionResponse, LeaseMode, NotificationEnvelope, NotificationPayload, PlatformFacts,
    PlatformKey, ResponseEnvelope, ResponsePayload, RuntimeEvent, RuntimeProvenance, RuntimeState,
    RuntimeStateNotification, SandboxBackend, SandboxLevel, SandboxStatus, SessionCommand,
    SessionNotification, SessionResult, SnapshotRequest, SteerRequest, SubmitPromptRequest,
    TransferControllerRequest,
};
use aio_dsh_supervisor::idempotency::{
    MutationLedger, MutationRecord, capability_for_command, request_id_of,
};
use aio_dsh_supervisor::{
    PlatformTarget, RedactionPolicy, SpawnSpec, Supervisor, SupervisorConfig,
    lifecycle::{LifecycleEvent, LifecycleMachine},
    materialize_host_patch,
    runtime::DSH_CONTRACT_HASH,
    supervisor::SupervisorError,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

const DEFAULT_PLATFORM: &str = "win32-x64";
const DEFAULT_HOST_API_VERSION: u16 = 3;
const CRASH_EXIT_CODE: u8 = 86;

/// Host-side binding inputs resolved once from the release layout and the
/// managed plugin data directory.
struct HostBinding {
    enabled: bool,
    module: PathBuf,
    patch_template: PathBuf,
    managed_patch: PathBuf,
}

const ENV_PLUGIN_DATA_DIR: &str = "AIO_DSH_SUPERVISOR_PLUGIN_DATA_DIR";
const ENV_HOST_PLUGIN_DATA_DIR: &str = "AIOHUB_PLUGIN_DATA_DIR";
const ENV_RUNTIME_LOCK_PATH: &str = "AIO_DSH_SUPERVISOR_RUNTIME_LOCK_PATH";
const ENV_RUNTIME_ROOT: &str = "AIO_DSH_SUPERVISOR_RUNTIME_ROOT";
const ENV_PLATFORM: &str = "AIO_DSH_SUPERVISOR_PLATFORM";
const ENV_HOST_API_VERSION: &str = "AIO_DSH_SUPERVISOR_HOST_API_VERSION";
const ENV_PREWARM: &str = "AIO_DSH_SUPERVISOR_PREWARM";
const ENV_TELEMETRY: &str = "AIO_DSH_SUPERVISOR_TELEMETRY";
const ENV_CRASH_TOKEN: &str = "AIO_DSH_E2E_CRASH_TOKEN";
const INTERRUPTED_TURN_LEDGER_FILE: &str = "interrupted-turns.json";
/// Bounded exactly-once window: how many recent mutation records the in-memory
/// ledger keeps per connection. The map evicts an arbitrary entry once the
/// capacity is reached (see `MutationLedger::insert_and_trim`); eviction order
/// is unspecified, only the bound is guaranteed.
const MUTATION_LEDGER_CAPACITY: usize = 512;

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            let _ = writeln!(
                io::stderr(),
                "{}",
                RedactionPolicy::default().redact_text(&error.to_string())
            );
            ExitCode::from(1)
        }
    }
}

fn run() -> Result<u8, MainError> {
    let config = load_config()?;
    let redaction = config.redaction.clone();
    let interrupted_turns_path = interrupted_turns_path(&config.plugin_data_dir);
    let dsh_home = config.plugin_data_dir.join("data").join("dsh-home");
    let runtime_executable = config
        .runtime_root
        .join("deepseek-harness-sdk-runtime-win-x64.exe");
    let release_root = config
        .runtime_root
        .parent()
        .ok_or_else(|| MainError::Config("runtime root has no release parent".to_owned()))?;
    let host_module = release_root.join("host").join("aio-dsh-host.mjs");
    let host_patch_template = release_root.join("host").join("cordis.patch.yml");
    let managed_host_patch = config
        .plugin_data_dir
        .join("runtime")
        .join("aio-host.patch.yml");
    let host_enabled = host_module.is_file() && host_patch_template.is_file();
    let supervisor = Supervisor::new(config)?;
    let mut driver = StdioDriver::new(
        supervisor,
        redaction,
        std::env::var(ENV_CRASH_TOKEN).ok(),
        interrupted_turns_path,
        runtime_executable,
        dsh_home,
        HostBinding {
            enabled: host_enabled,
            module: host_module,
            patch_template: host_patch_template,
            managed_patch: managed_host_patch,
        },
    )?;
    driver.run(io::stdin().lock(), io::stdout().lock())
}

fn load_config() -> Result<SupervisorConfig, MainError> {
    let platform_value =
        std::env::var(ENV_PLATFORM).unwrap_or_else(|_| DEFAULT_PLATFORM.to_owned());
    let platform = PlatformTarget::try_from(platform_value.as_str())
        .map_err(|error| MainError::Config(error.to_string()))?;
    let host_api_version = std::env::var(ENV_HOST_API_VERSION)
        .ok()
        .map(|value| value.parse::<u16>())
        .transpose()
        .map_err(|error| MainError::Config(format!("invalid {ENV_HOST_API_VERSION}: {error}")))?
        .unwrap_or(DEFAULT_HOST_API_VERSION);

    Ok(SupervisorConfig {
        plugin_data_dir: read_plugin_data_dir()?,
        runtime_lock_path: read_release_path(ENV_RUNTIME_LOCK_PATH, "runtime-lock.json")?,
        runtime_root: read_release_path(ENV_RUNTIME_ROOT, "bin")?,
        platform,
        host_api_version,
        prewarm: parse_bool_env(ENV_PREWARM)?,
        telemetry_enabled: parse_bool_env(ENV_TELEMETRY)?,
        redaction: RedactionPolicy::default(),
    })
}

fn read_plugin_data_dir() -> Result<PathBuf, MainError> {
    std::env::var_os(ENV_PLUGIN_DATA_DIR)
        .or_else(|| std::env::var_os(ENV_HOST_PLUGIN_DATA_DIR))
        .map(PathBuf::from)
        .ok_or_else(|| {
            MainError::Config(format!(
                "missing required environment variable {ENV_PLUGIN_DATA_DIR} or {ENV_HOST_PLUGIN_DATA_DIR}"
            ))
        })
}

fn read_release_path(name: &str, release_relative_path: &str) -> Result<PathBuf, MainError> {
    if let Some(path) = std::env::var_os(name).map(PathBuf::from) {
        return Ok(path);
    }
    std::env::current_dir()
        .map(|root| root.join(release_relative_path))
        .map_err(MainError::Io)
}

fn host_initialize_request(
    params: &serde_json::Value,
) -> Result<aio_dsh_protocol::InitializeRequest, MainError> {
    let api_version = params
        .get("hostContext")
        .and_then(|context| context.get("apiVersion"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(u64::from(DEFAULT_HOST_API_VERSION));
    if api_version != u64::from(DEFAULT_HOST_API_VERSION) {
        return Err(MainError::Config(format!(
            "unsupported host API version {api_version}"
        )));
    }
    Ok(aio_dsh_protocol::InitializeRequest {
        protocol_version: CURRENT_PROTOCOL_VERSION,
        contract_hash: DSH_CONTRACT_HASH.to_owned(),
        runtime: RuntimeProvenance {
            component: "aio-dsh-supervisor".to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            build_id: "resident-sidecar".to_owned(),
            source_revision: None,
        },
        platform: PlatformFacts {
            platform: PlatformKey::Win32X64,
            architecture: "x64".to_owned(),
            sandbox: SandboxStatus {
                level: SandboxLevel::Full,
                backend: SandboxBackend::RestrictedToken,
                reason: None,
            },
        },
        stable_capabilities: vec!["session".to_owned(), "snapshot".to_owned()],
        required_stable_capabilities: Vec::new(),
        experimental_capabilities: Vec::new(),
    })
}

fn parse_bool_env(name: &str) -> Result<bool, MainError> {
    match std::env::var(name) {
        Ok(value) => match value.as_str() {
            "1" | "true" | "TRUE" | "True" => Ok(true),
            "0" | "false" | "FALSE" | "False" => Ok(false),
            _ => Err(MainError::Config(format!("invalid boolean {name}={value}"))),
        },
        Err(std::env::VarError::NotPresent) => Ok(false),
        Err(std::env::VarError::NotUnicode(_)) => Err(MainError::Config(format!(
            "environment variable {name} is not valid Unicode"
        ))),
    }
}

#[derive(Debug)]
enum MainError {
    Config(String),
    Io(io::Error),
    Supervisor(SupervisorError),
}

impl std::fmt::Display for MainError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Config(message) => formatter.write_str(message),
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Supervisor(error) => write!(formatter, "{error}"),
        }
    }
}

impl From<io::Error> for MainError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<SupervisorError> for MainError {
    fn from(value: SupervisorError) -> Self {
        Self::Supervisor(value)
    }
}

#[derive(Clone)]
struct LeaseRecord {
    lease: ControllerLease,
    view_id: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InterruptedTurnLedger {
    #[serde(default)]
    turns: BTreeSet<InterruptedTurnKey>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InterruptedTurnKey {
    session_id: String,
    turn_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResidentHostCommand {
    id: u64,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

/// Structured ledger verdict for a mutation outcome. Carried by the outcome
/// itself instead of being sniffed from serialized frame contents, so a
/// successful event payload that merely mentions a rejection code can never
/// flip the ledger into discarding an executed mutation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MutationDisposition {
    /// The mutation ran downstream and its result must be recorded.
    Executed,
    /// The mutation was rejected before any downstream transition and its
    /// ledger reservation must be released.
    Rejected,
}

struct CommandOutcome {
    frames: Vec<String>,
    exit_code: Option<u8>,
    disposition: MutationDisposition,
}

impl CommandOutcome {
    fn frame(frame: String) -> Self {
        Self {
            frames: vec![frame],
            exit_code: None,
            disposition: MutationDisposition::Executed,
        }
    }

    fn with_frames(frames: Vec<String>) -> Self {
        Self {
            frames,
            exit_code: None,
            disposition: MutationDisposition::Executed,
        }
    }

    fn rejected(frames: Vec<String>) -> Self {
        Self {
            frames,
            exit_code: None,
            disposition: MutationDisposition::Rejected,
        }
    }
}

struct SessionEventSpec {
    seq: u64,
    message_id: String,
    correlation_id: Option<String>,
    generation_id: String,
    session_id: Option<String>,
    turn_id: Option<String>,
    kind: String,
    data: serde_json::Value,
}

#[derive(Default)]
struct WireFrameContext {
    seq: u64,
    message_id: Option<String>,
    correlation_id: Option<String>,
}

struct StdioDriver {
    supervisor: Supervisor,
    platform: PlatformTarget,
    lifecycle: LifecycleMachine,
    redaction: RedactionPolicy,
    crash_token: Option<String>,
    controller_leases: BTreeMap<String, LeaseRecord>,
    mutation_ledger: MutationLedger,
    negotiated_capabilities: BTreeSet<String>,
    interrupted_turns_path: PathBuf,
    interrupted_turns: InterruptedTurnLedger,
    runtime_executable: PathBuf,
    dsh_home: PathBuf,
    host_enabled: bool,
    host_module: PathBuf,
    host_patch_template: PathBuf,
    managed_host_patch: PathBuf,
    host_environment: BTreeMap<String, std::ffi::OsString>,
    host_sessions: BTreeSet<String>,
    pending_interactions: BTreeMap<String, InteractionRequest>,
    resolved_interactions: BTreeSet<String>,
    next_lease_id: AtomicU64,
    next_wire_error_id: u64,
    initialized: bool,
}

impl StdioDriver {
    fn new(
        supervisor: Supervisor,
        redaction: RedactionPolicy,
        crash_token: Option<String>,
        interrupted_turns_path: PathBuf,
        runtime_executable: PathBuf,
        dsh_home: PathBuf,
        host: HostBinding,
    ) -> Result<Self, MainError> {
        let HostBinding {
            enabled: host_enabled,
            module: host_module,
            patch_template: host_patch_template,
            managed_patch: managed_host_patch,
        } = host;
        let platform = supervisor.platform();
        Ok(Self {
            supervisor,
            platform,
            lifecycle: LifecycleMachine::new(Duration::from_secs(600)),
            redaction,
            crash_token,
            controller_leases: BTreeMap::new(),
            mutation_ledger: MutationLedger::new(MUTATION_LEDGER_CAPACITY),
            negotiated_capabilities: BTreeSet::new(),
            interrupted_turns: load_interrupted_turns(&interrupted_turns_path)?,
            interrupted_turns_path,
            runtime_executable,
            dsh_home,
            host_enabled,
            host_module,
            host_patch_template,
            managed_host_patch,
            host_environment: BTreeMap::new(),
            host_sessions: BTreeSet::new(),
            pending_interactions: BTreeMap::new(),
            resolved_interactions: BTreeSet::new(),
            next_lease_id: AtomicU64::new(1),
            next_wire_error_id: 1,
            initialized: false,
        })
    }

    fn run<R: BufRead, W: Write>(&mut self, mut input: R, mut output: W) -> Result<u8, MainError> {
        let mut line = String::new();
        loop {
            line.clear();
            let read = input.read_line(&mut line)?;
            if read == 0 {
                return Ok(0);
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let outcome = match serde_json::from_str::<CommandEnvelope>(trimmed) {
                Ok(command) => self.handle_command(command.0)?,
                Err(envelope_error) => match serde_json::from_str::<ResidentHostCommand>(trimmed) {
                    Ok(command) => self.handle_resident_host_command(command)?,
                    Err(_) => {
                        CommandOutcome::frame(self.wire_error_frame(trimmed, &envelope_error)?)
                    }
                },
            };
            for frame in outcome.frames {
                output.write_all(frame.as_bytes())?;
                output.write_all(b"\n")?;
            }
            output.flush()?;
            if let Some(code) = outcome.exit_code {
                return Ok(code);
            }
        }
    }

    fn handle_resident_host_command(
        &mut self,
        command: ResidentHostCommand,
    ) -> Result<CommandOutcome, MainError> {
        let outcome = match command.method.as_str() {
            "initialize" => {
                self.configure_host_environment(&command.params)?;
                let request = host_initialize_request(&command.params)?;
                self.handle_initialize(
                    Envelope::new(
                        "host-bootstrap",
                        command.id,
                        CommandPayload::Initialize(request.clone()),
                    ),
                    request,
                )?
            }
            "shutdown" => self.handle_shutdown(command.id, None)?,
            "session.acquire"
            | "session.submitPrompt"
            | "session.cancel"
            | "session.steer"
            | "session.transferController"
            | "session.snapshot" => {
                match resident_session_command(&command.method, &command.params, command.id) {
                    Ok(session_command) => {
                        let generation = self.current_generation().to_owned();
                        self.handle_command(Envelope::new(
                            generation,
                            command.id,
                            CommandPayload::Session(session_command),
                        ))?
                    }
                    Err(message) => CommandOutcome::frame(self.error_event_frame(
                        command.id,
                        format!("host-command-{}", command.id),
                        None,
                        self.current_generation().to_owned(),
                        "invalid-host-params",
                        &message,
                    )?),
                }
            }
            "interaction.respond" => {
                match resident_interaction_response(&command.params, self.current_generation()) {
                    Ok(response) => {
                        let generation = self.current_generation().to_owned();
                        self.handle_command(Envelope::new(
                            generation,
                            command.id,
                            CommandPayload::Interaction(response),
                        ))?
                    }
                    Err(message) => CommandOutcome::frame(self.error_event_frame(
                        command.id,
                        format!("host-command-{}", command.id),
                        None,
                        self.current_generation().to_owned(),
                        "invalid-host-params",
                        &message,
                    )?),
                }
            }
            _ => CommandOutcome::frame(self.error_event_frame(
                command.id,
                format!("host-command-{}", command.id),
                None,
                self.current_generation().to_owned(),
                "unsupported-host-method",
                &format!("unsupported resident Sidecar method {}", command.method),
            )?),
        };
        self.wrap_resident_host_outcome(command.id, outcome)
    }

    fn wrap_resident_host_outcome(
        &self,
        id: u64,
        outcome: CommandOutcome,
    ) -> Result<CommandOutcome, MainError> {
        let mut state = None;
        let mut error = None;
        let mut result_data = serde_json::Map::new();
        for frame in &outcome.frames {
            let value: serde_json::Value = serde_json::from_str(frame)
                .map_err(|parse_error| MainError::Config(parse_error.to_string()))?;
            let payload = &value["payload"];
            match payload["kind"].as_str() {
                Some("state") => {
                    state = payload["data"]["state"].as_str().map(str::to_owned);
                }
                Some("session") => {
                    let data = &payload["data"];
                    match data["kind"].as_str() {
                        Some("lease") => {
                            result_data.insert("lease".to_owned(), data["data"].clone());
                        }
                        Some("accepted") => {
                            result_data
                                .insert("accepted".to_owned(), data["data"]["accepted"].clone());
                        }
                        Some("snapshot") => {
                            result_data.insert("snapshot".to_owned(), data["data"].clone());
                        }
                        Some("event") => match data["data"]["kind"].as_str() {
                            Some("turn-completed") => {
                                result_data.insert("terminal".to_owned(), json!("completed"));
                                result_data.insert(
                                    "output".to_owned(),
                                    data["data"]["data"]["output"].clone(),
                                );
                            }
                            Some("error") => {
                                error = Some(data["data"]["data"].clone());
                            }
                            Some("command-rejected") => {
                                result_data.insert(
                                    "rejection".to_owned(),
                                    json!({ "code": data["data"]["data"]["code"] }),
                                );
                            }
                            _ => {}
                        },
                        _ => {}
                    }
                }
                Some("interaction") => {
                    let interactions = result_data
                        .entry("interactions".to_owned())
                        .or_insert_with(|| json!([]));
                    if let Some(items) = interactions.as_array_mut() {
                        items.push(payload["data"].clone());
                    }
                }
                Some("interaction-resolved") => {
                    result_data.insert("interactionResolved".to_owned(), payload["data"].clone());
                }
                Some("error") => {
                    error = Some(payload["data"].clone());
                }
                _ => {}
            }
        }
        let frame = if let Some(error) = error {
            json!({ "id": id, "type": "error", "data": error })
        } else {
            result_data.insert(
                "domainGenerationId".to_owned(),
                json!(self.current_generation()),
            );
            if let Some(state) = state {
                result_data.insert("state".to_owned(), json!(state));
            }
            if result_data.len() <= 1 {
                json!({
                    "id": id,
                    "type": "error",
                    "data": { "code": "resident-command-no-terminal-result" }
                })
            } else {
                json!({ "id": id, "type": "result", "data": result_data })
            }
        };
        Ok(CommandOutcome {
            frames: vec![frame.to_string()],
            exit_code: outcome.exit_code,
            disposition: outcome.disposition,
        })
    }

    fn handle_command(
        &mut self,
        envelope: Envelope<CommandPayload>,
    ) -> Result<CommandOutcome, MainError> {
        match envelope.payload.clone() {
            CommandPayload::Initialize(request) => self.handle_initialize(envelope, request),
            CommandPayload::Ping => Ok(CommandOutcome::frame(self.response_frame(
                &envelope,
                ResponsePayload::Pong(aio_dsh_protocol::PongResult { seq: envelope.seq }),
            )?)),
            CommandPayload::Shutdown(_) => {
                self.handle_shutdown(envelope.seq, envelope.correlation_id)
            }
            CommandPayload::Session(command) => self.handle_session_command(envelope, command),
            CommandPayload::Interaction(response) => self.handle_interaction(envelope, response),
        }
    }

    fn handle_initialize(
        &mut self,
        envelope: Envelope<CommandPayload>,
        request: aio_dsh_protocol::InitializeRequest,
    ) -> Result<CommandOutcome, MainError> {
        if self.initialized {
            return Ok(CommandOutcome::frame(self.error_event_frame(
                envelope.seq,
                format!("{}:error", envelope.message_id),
                envelope.correlation_id,
                envelope.domain_generation_id,
                "already-initialized",
                "initialize may only succeed once per stdio connection",
            )?));
        }

        self.lifecycle.apply(LifecycleEvent::DemandStart);
        let generation_id = self.current_generation().to_owned();
        let result = self
            .supervisor
            .validate_runtime_layout(required_runtime_files(self.platform))
            .and_then(|_| self.supervisor.initialize(&request));

        match result {
            Ok(negotiated) => {
                let mut host_capabilities = negotiated.stable_capabilities.clone();
                if self.host_enabled {
                    match self.start_managed_host() {
                        Ok(capabilities) => host_capabilities.extend(capabilities),
                        Err(error) => {
                            self.lifecycle.apply(LifecycleEvent::StartFailed);
                            let _ = self.supervisor.shutdown();
                            return Ok(CommandOutcome::frame(self.error_event_frame(
                                envelope.seq,
                                format!("{}:error", envelope.message_id),
                                envelope.correlation_id,
                                generation_id,
                                "host-initialize-failed",
                                &error.to_string(),
                            )?));
                        }
                    }
                }
                self.initialized = true;
                self.mutation_ledger.begin_generation(&generation_id);
                self.negotiated_capabilities = host_capabilities.into_iter().collect();
                self.lifecycle.apply(LifecycleEvent::DshQuiescent {
                    jobs: 0,
                    interactions: 0,
                });
                Ok(CommandOutcome::frame(self.state_frame(
                    envelope.seq,
                    format!("{}:ready", envelope.message_id),
                    envelope.correlation_id,
                    generation_id,
                    RuntimeState::Ready,
                )?))
            }
            Err(error) => {
                self.lifecycle.apply(LifecycleEvent::StartFailed);
                match error {
                    SupervisorError::Protocol(protocol_error) => {
                        Ok(CommandOutcome::frame(self.response_frame_with_generation(
                            envelope.seq,
                            format!("{}:response", envelope.message_id),
                            envelope.correlation_id,
                            generation_id,
                            ResponsePayload::Error(protocol_error),
                        )?))
                    }
                    other => Ok(CommandOutcome::frame(self.error_event_frame(
                        envelope.seq,
                        format!("{}:error", envelope.message_id),
                        envelope.correlation_id,
                        generation_id,
                        "initialize-failed",
                        &other.to_string(),
                    )?)),
                }
            }
        }
    }

    fn handle_shutdown(
        &mut self,
        seq: u64,
        correlation_id: Option<String>,
    ) -> Result<CommandOutcome, MainError> {
        if self.host_enabled {
            let request = json!({ "id": 0, "method": "shutdown", "params": {} }).to_string();
            self.supervisor.stop_host(&request)?;
        }
        let generation_id = self.current_generation().to_owned();
        let mut frames = Vec::new();
        for (session_id, record) in std::mem::take(&mut self.controller_leases) {
            frames.push(self.session_event_frame(SessionEventSpec {
                seq,
                message_id: format!("shutdown-release-{session_id}"),
                correlation_id: correlation_id.clone(),
                generation_id: generation_id.clone(),
                session_id: Some(session_id),
                turn_id: None,
                kind: "lease-released".to_owned(),
                data: json!({
                    "leaseId": record.lease.lease_id,
                    "mode": record.lease.mode,
                    "releasedBy": "shutdown",
                    "viewId": record.view_id,
                }),
            })?);
        }
        frames.push(self.state_frame(
            seq,
            "shutdown:stopped".to_owned(),
            correlation_id,
            generation_id,
            RuntimeState::Stopped,
        )?);
        Ok(CommandOutcome {
            frames,
            exit_code: Some(0),
            disposition: MutationDisposition::Executed,
        })
    }

    fn handle_session_command(
        &mut self,
        envelope: Envelope<CommandPayload>,
        command: SessionCommand,
    ) -> Result<CommandOutcome, MainError> {
        if !self.initialized {
            return Ok(CommandOutcome::frame(self.error_event_frame(
                envelope.seq,
                format!("{}:error", envelope.message_id),
                envelope.correlation_id,
                envelope.domain_generation_id,
                "not-initialized",
                "initialize must complete before session commands",
            )?));
        }

        let active_generation = self.current_generation().to_owned();
        if envelope.domain_generation_id != active_generation {
            return self.reject_command(
                &envelope,
                session_id_for_command(&command),
                lease_id_for_command(&command),
                turn_id_for_command(&command),
                "stale-generation",
                &format!(
                    "expected domainGenerationId {active_generation}, received {}",
                    envelope.domain_generation_id
                ),
            );
        }

        // Capability gate: every session command is checked against the
        // negotiated capability set from initialize before it can reach the
        // Host path. The mapping mirrors the protocol capability catalog.
        let capability_id = capability_for_command(&command);
        if !self.negotiated_capabilities.contains(capability_id) {
            return self.reject_command(
                &envelope,
                session_id_for_command(&command),
                lease_id_for_command(&command),
                turn_id_for_command(&command),
                "capability-not-negotiated",
                &format!("capability {capability_id} was not negotiated for this connection"),
            );
        }

        // Exactly-once gate: reserve the request identity before the mutation
        // runs. A retransmission of a completed request replays the recorded
        // frames; anything else is rejected or starts a fresh reservation.
        let request_id = request_id_of(&command).map(str::to_owned);
        if let Some(request_id) = request_id
            && let Some(record) = self.mutation_ledger.begin(&active_generation, &request_id)
        {
            return match record {
                MutationRecord::Completed(frames) => Ok(CommandOutcome::with_frames(frames)),
                MutationRecord::Pending | MutationRecord::Indeterminate => self.reject_command(
                    &envelope,
                    session_id_for_command(&command),
                    lease_id_for_command(&command),
                    turn_id_for_command(&command),
                    "request-in-flight",
                    "a mutation with this requestId is already in flight or its outcome is unknown; retry with a new requestId after the current outcome resolves",
                ),
            };
        }

        match command {
            SessionCommand::Acquire(request) => {
                let request_id = request.request_id.clone();
                let outcome = self.handle_acquire(envelope, request)?;
                self.settle_mutation(&active_generation, &request_id, outcome)
            }
            SessionCommand::TransferController(request) => {
                let request_id = request.request_id.clone();
                let outcome = self.handle_transfer(
                    envelope,
                    request.session_id,
                    request.lease_id,
                    request.target_view_id,
                )?;
                self.settle_mutation(&active_generation, &request_id, outcome)
            }
            SessionCommand::SubmitPrompt(request) => {
                let request_id = request.request_id.clone();
                let outcome = self.handle_submit_like(
                    envelope,
                    request.session_id,
                    request.lease_id,
                    request.turn_id,
                    request.input,
                    "submit-prompt",
                )?;
                self.settle_mutation(&active_generation, &request_id, outcome)
            }
            SessionCommand::Cancel(request) => {
                let request_id = request.request_id.clone();
                let outcome = self.handle_cancel(envelope, request)?;
                self.settle_mutation(&active_generation, &request_id, outcome)
            }
            SessionCommand::Steer(request) => {
                let request_id = request.request_id.clone();
                let outcome = self.handle_submit_like(
                    envelope,
                    request.session_id,
                    request.lease_id,
                    request.turn_id,
                    request.input,
                    "steer",
                )?;
                self.settle_mutation(&active_generation, &request_id, outcome)
            }
            SessionCommand::Snapshot(request) => {
                if self.host_enabled {
                    self.handle_host_snapshot(envelope, request)
                } else {
                    Ok(CommandOutcome::frame(self.response_frame(
                        &envelope,
                        ResponsePayload::Session(SessionResult::Snapshot(
                            aio_dsh_protocol::SessionSnapshot {
                                domain_generation_id: active_generation,
                                contract_hash: DSH_CONTRACT_HASH.to_owned(),
                                session_id: request.session_id,
                                cursor: "cursor-0".to_owned(),
                                seq: envelope.seq,
                                durable_facts: Vec::new(),
                            },
                        )),
                    )?))
                }
            }
        }
    }

    fn handle_cancel(
        &mut self,
        envelope: Envelope<CommandPayload>,
        request: CancelRequest,
    ) -> Result<CommandOutcome, MainError> {
        if let Some(rejected) = self.validate_controller_lease(
            &envelope,
            &request.session_id,
            &request.lease_id,
            Some(&request.turn_id),
        )? {
            return Ok(rejected);
        }
        if self.host_enabled {
            let result =
                self.host_result("session.cancel", json!({ "sessionId": request.session_id }))?;
            if result.get("accepted").and_then(serde_json::Value::as_bool) != Some(true) {
                return self.reject_command(
                    &envelope,
                    Some(request.session_id),
                    Some(request.lease_id),
                    Some(request.turn_id),
                    "cancel-not-accepted",
                    "DSH did not accept cancellation for the active session",
                );
            }
        }
        self.handle_accepting_mutation(
            envelope,
            request.session_id,
            request.lease_id,
            Some(request.turn_id),
            "cancel-requested",
        )
    }

    fn handle_interaction(
        &mut self,
        envelope: Envelope<CommandPayload>,
        response: InteractionResponse,
    ) -> Result<CommandOutcome, MainError> {
        if !self.initialized {
            return self.reject_command(
                &envelope,
                Some(response.session_id),
                Some(response.lease_id),
                None,
                "not-initialized",
                "initialize must complete before interaction responses",
            );
        }
        if response.domain_generation_id != self.current_generation()
            || envelope.domain_generation_id != self.current_generation()
        {
            return self.reject_command(
                &envelope,
                Some(response.session_id),
                Some(response.lease_id),
                None,
                "stale-generation",
                "interaction response belongs to an inactive generation",
            );
        }
        if let Some(rejected) = self.validate_controller_lease(
            &envelope,
            &response.session_id,
            &response.lease_id,
            None,
        )? {
            return Ok(rejected);
        }
        let Some(request) = self
            .pending_interactions
            .get(&response.correlation_id)
            .cloned()
        else {
            let code = if self
                .resolved_interactions
                .contains(&response.correlation_id)
            {
                "interaction-resolved"
            } else {
                "unknown-interaction"
            };
            return self.reject_command(
                &envelope,
                Some(response.session_id),
                Some(response.lease_id),
                None,
                code,
                "interaction is not pending in the active generation",
            );
        };
        if request.session_id != response.session_id {
            return self.reject_command(
                &envelope,
                Some(response.session_id),
                Some(response.lease_id),
                None,
                "interaction-session-mismatch",
                "interaction belongs to a different DSH session",
            );
        }
        if request.kind == InteractionKind::Question {
            return self.reject_command(
                &envelope,
                Some(response.session_id),
                Some(response.lease_id),
                None,
                "capability-not-negotiated",
                "the active DSH adapter does not advertise question interactions",
            );
        }
        if self.host_enabled {
            self.host_result(
                "interaction.respond",
                json!({
                    "sessionId": response.session_id,
                    "correlationId": response.correlation_id,
                    "decision": host_interaction_decision(&response.decision),
                    "data": response.data,
                }),
            )?;
        }
        self.pending_interactions.remove(&response.correlation_id);
        self.resolved_interactions
            .insert(response.correlation_id.clone());
        let reason = match response.decision {
            InteractionDecision::Cancel => InteractionResolutionReason::Cancelled,
            InteractionDecision::Timeout => InteractionResolutionReason::Timeout,
            _ => InteractionResolutionReason::Answered,
        };
        Ok(CommandOutcome {
            frames: vec![
                self.response_frame(
                    &envelope,
                    ResponsePayload::Session(SessionResult::Accepted(CommandAccepted {
                        accepted: true,
                    })),
                )?,
                self.interaction_resolved_frame(
                    envelope.seq,
                    envelope.correlation_id,
                    InteractionResolved {
                        domain_generation_id: self.current_generation().to_owned(),
                        contract_hash: DSH_CONTRACT_HASH.to_owned(),
                        session_id: response.session_id,
                        correlation_id: response.correlation_id,
                        reason,
                    },
                )?,
            ],
            exit_code: None,
            disposition: MutationDisposition::Executed,
        })
    }

    /// Records the outcome of one mutation execution in the ledger. Successful
    /// outcomes store their frames so a retransmission replays them verbatim
    /// (downstream effect count stays at one); downstream rejections free the
    /// reservation; a crash leaves the request indeterminate. The verdict is
    /// the typed `MutationDisposition` carried by the outcome, never inferred
    /// from serialized frame contents.
    fn settle_mutation(
        &mut self,
        generation_id: &str,
        request_id: &str,
        outcome: CommandOutcome,
    ) -> Result<CommandOutcome, MainError> {
        if outcome.exit_code == Some(CRASH_EXIT_CODE) {
            self.mutation_ledger.interrupt(generation_id, request_id);
        } else if outcome.disposition == MutationDisposition::Rejected {
            self.mutation_ledger.discard(generation_id, request_id);
        } else {
            self.mutation_ledger
                .complete(generation_id, request_id, outcome.frames.clone());
        }
        Ok(outcome)
    }

    fn handle_acquire(
        &mut self,
        envelope: Envelope<CommandPayload>,
        request: aio_dsh_protocol::AcquireSessionRequest,
    ) -> Result<CommandOutcome, MainError> {
        if request.requested_mode == LeaseMode::Controller
            && let Some(existing) = self.controller_leases.get(&request.session_id).cloned()
        {
            let mut rejected = self.reject_command(
                &envelope,
                Some(request.session_id.clone()),
                Some(existing.lease.lease_id.clone()),
                None,
                "lease-rejected",
                "session already has a controller lease",
            )?;
            rejected.frames.insert(
                0,
                self.session_event_frame(SessionEventSpec {
                    seq: envelope.seq,
                    message_id: format!("lease-rejected-{}", request.session_id),
                    correlation_id: envelope.correlation_id.clone(),
                    generation_id: self.current_generation().to_owned(),
                    session_id: Some(request.session_id),
                    turn_id: None,
                    kind: "lease-rejected".to_owned(),
                    data: json!({
                        "leaseId": existing.lease.lease_id,
                        "mode": existing.lease.mode,
                        "viewId": existing.view_id,
                    }),
                })?,
            );
            return Ok(rejected);
        }

        let lease = self.issue_lease(request.session_id.clone(), request.requested_mode.clone());
        if request.requested_mode == LeaseMode::Controller {
            self.controller_leases.insert(
                request.session_id.clone(),
                LeaseRecord {
                    lease: lease.clone(),
                    view_id: request.view_id.clone(),
                },
            );
        }

        Ok(CommandOutcome {
            frames: vec![
                self.response_frame(
                    &envelope,
                    ResponsePayload::Session(SessionResult::Lease(lease.clone())),
                )?,
                self.session_event_frame(SessionEventSpec {
                    seq: envelope.seq,
                    message_id: format!("lease-granted-{}", lease.session_id),
                    correlation_id: envelope.correlation_id,
                    generation_id: self.current_generation().to_owned(),
                    session_id: Some(lease.session_id),
                    turn_id: None,
                    kind: "lease-granted".to_owned(),
                    data: json!({
                        "leaseId": lease.lease_id,
                        "mode": lease.mode,
                        "viewId": request.view_id,
                    }),
                })?,
            ],
            exit_code: None,
            disposition: MutationDisposition::Executed,
        })
    }

    fn handle_transfer(
        &mut self,
        envelope: Envelope<CommandPayload>,
        session_id: String,
        lease_id: String,
        target_view_id: String,
    ) -> Result<CommandOutcome, MainError> {
        let Some(existing) = self.controller_leases.get(&session_id).cloned() else {
            return self.reject_command(
                &envelope,
                Some(session_id),
                Some(lease_id),
                None,
                "unknown-lease",
                "no controller lease exists for the requested session",
            );
        };

        if existing.lease.lease_id != lease_id {
            return self.reject_command(
                &envelope,
                Some(existing.lease.session_id),
                Some(lease_id),
                None,
                "stale-lease",
                "leaseId does not match the active controller lease",
            );
        }

        let new_lease = self.issue_lease(existing.lease.session_id.clone(), LeaseMode::Controller);
        self.controller_leases.insert(
            existing.lease.session_id.clone(),
            LeaseRecord {
                lease: new_lease.clone(),
                view_id: target_view_id.clone(),
            },
        );

        Ok(CommandOutcome {
            frames: vec![
                self.session_event_frame(SessionEventSpec {
                    seq: envelope.seq,
                    message_id: format!("lease-released-{}", existing.lease.session_id),
                    correlation_id: envelope.correlation_id.clone(),
                    generation_id: self.current_generation().to_owned(),
                    session_id: Some(existing.lease.session_id.clone()),
                    turn_id: None,
                    kind: "lease-released".to_owned(),
                    data: json!({
                        "leaseId": existing.lease.lease_id,
                        "mode": existing.lease.mode,
                        "releasedBy": "transfer-controller",
                        "viewId": existing.view_id,
                    }),
                })?,
                self.response_frame(
                    &envelope,
                    ResponsePayload::Session(SessionResult::Lease(new_lease.clone())),
                )?,
                self.session_event_frame(SessionEventSpec {
                    seq: envelope.seq,
                    message_id: format!("lease-granted-{}", new_lease.session_id),
                    correlation_id: envelope.correlation_id,
                    generation_id: self.current_generation().to_owned(),
                    session_id: Some(new_lease.session_id),
                    turn_id: None,
                    kind: "lease-granted".to_owned(),
                    data: json!({
                        "leaseId": new_lease.lease_id,
                        "mode": new_lease.mode,
                        "viewId": target_view_id,
                    }),
                })?,
            ],
            exit_code: None,
            disposition: MutationDisposition::Executed,
        })
    }

    fn handle_submit_like(
        &mut self,
        envelope: Envelope<CommandPayload>,
        session_id: String,
        lease_id: String,
        turn_id: String,
        input: serde_json::Value,
        event_kind: &str,
    ) -> Result<CommandOutcome, MainError> {
        if let Some(rejected) =
            self.validate_controller_lease(&envelope, &session_id, &lease_id, Some(&turn_id))?
        {
            return Ok(rejected);
        }

        if self.is_interrupted_turn(&session_id, &turn_id) {
            return self.reject_command(
                &envelope,
                Some(session_id),
                Some(lease_id),
                Some(turn_id),
                "interrupted-turn",
                "turn was already interrupted before completion; retry with a new turnId",
            );
        }

        if self.should_crash(&input) {
            self.record_interrupted_turn(&session_id, &turn_id)?;
            self.lifecycle.apply(LifecycleEvent::ChildExited {
                active_turn: Some(turn_id.clone()),
            });
            return Ok(CommandOutcome {
                frames: vec![
                    self.session_event_frame(SessionEventSpec {
                        seq: envelope.seq,
                        message_id: format!("turn-interrupted-{turn_id}"),
                        correlation_id: envelope.correlation_id.clone(),
                        generation_id: self.current_generation().to_owned(),
                        session_id: Some(session_id),
                        turn_id: Some(turn_id),
                        kind: "turn-interrupted".to_owned(),
                        data: json!({
                            "reason": "crash-inject",
                            "replayedEffects": 0,
                        }),
                    })?,
                    self.state_frame(
                        envelope.seq,
                        "state:crashed".to_owned(),
                        envelope.correlation_id,
                        self.current_generation().to_owned(),
                        RuntimeState::Crashed,
                    )?,
                ],
                exit_code: Some(CRASH_EXIT_CODE),
                disposition: MutationDisposition::Executed,
            });
        }

        if input.get("provider").is_some() {
            return self.handle_coding_turn(
                envelope,
                session_id,
                lease_id,
                turn_id,
                input,
                event_kind == "steer",
            );
        }

        self.handle_accepting_mutation(envelope, session_id, lease_id, Some(turn_id), event_kind)
    }

    fn handle_coding_turn(
        &mut self,
        envelope: Envelope<CommandPayload>,
        session_id: String,
        lease_id: String,
        turn_id: String,
        input: serde_json::Value,
        steer: bool,
    ) -> Result<CommandOutcome, MainError> {
        let prompt = required_json_string(&input, "prompt")?;
        let workspace = PathBuf::from(required_json_string(&input, "workspace")?);
        let provider = input
            .get("provider")
            .ok_or_else(|| MainError::Config("missing provider".to_owned()))?;
        let base_url = required_json_string(provider, "baseUrl")?;
        let api_key = required_json_string(provider, "apiKey")?;

        if !base_url.starts_with("http://127.0.0.1:") && !base_url.starts_with("http://localhost:")
        {
            return Ok(CommandOutcome::frame(self.error_event_frame(
                envelope.seq,
                format!("turn-error-{turn_id}"),
                envelope.correlation_id,
                self.current_generation().to_owned(),
                "provider-not-loopback",
                "native release E2E provider must use loopback",
            )?));
        }
        fs::create_dir_all(&self.dsh_home)?;
        fs::create_dir_all(&workspace)?;

        if self.host_enabled {
            if !self.host_sessions.contains(&session_id) {
                self.host_result(
                    "session.create",
                    json!({
                        "sessionId": session_id,
                        "cwd": workspace,
                    }),
                )?;
                self.host_sessions.insert(session_id.clone());
            }
            let host_result = self.host_result(
                "session.submitPrompt",
                json!({
                    "sessionId": session_id,
                    "requestId": turn_id,
                    "mode": if steer { "steer" } else { "queue" },
                    "content": [{ "type": "text", "text": prompt }],
                }),
            )?;
            let accepted = host_result
                .get("accepted")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            return Ok(CommandOutcome {
                frames: vec![
                    self.response_frame(
                        &envelope,
                        ResponsePayload::Session(SessionResult::Accepted(CommandAccepted {
                            accepted,
                        })),
                    )?,
                    self.session_event_frame(SessionEventSpec {
                        seq: envelope.seq,
                        message_id: format!("turn-started-{turn_id}"),
                        correlation_id: envelope.correlation_id,
                        generation_id: self.current_generation().to_owned(),
                        session_id: Some(session_id),
                        turn_id: Some(turn_id),
                        kind: "turn-started".to_owned(),
                        data: json!({ "leaseId": lease_id, "source": "dsh-host" }),
                    })?,
                ],
                exit_code: None,
                disposition: MutationDisposition::Executed,
            });
        }

        let runtime_patch = self.ensure_headless_runtime_patch()?;
        let result = Command::new(&self.runtime_executable)
            .args(["--profile", "headless", "--patch"])
            .arg(&runtime_patch)
            .arg(&prompt)
            .current_dir(&workspace)
            .env("DSH_HOME", &self.dsh_home)
            .env("DSH_TELEMETRY_DISABLED", "1")
            .env("DEEPSEEK_API_KEY", api_key)
            .env("DEEPSEEK_BASE_URL", base_url)
            .output();
        let output = match result {
            Ok(output) if output.status.success() => String::from_utf8(output.stdout)
                .map_err(|error| {
                    MainError::Config(format!("runtime stdout was not UTF-8: {error}"))
                })?
                .trim()
                .to_owned(),
            Ok(output) => {
                let message = self
                    .redaction
                    .redact_text(&String::from_utf8_lossy(&output.stderr));
                return Ok(CommandOutcome::frame(self.error_event_frame(
                    envelope.seq,
                    format!("turn-error-{turn_id}"),
                    envelope.correlation_id,
                    self.current_generation().to_owned(),
                    "runtime-turn-failed",
                    message.trim(),
                )?));
            }
            Err(error) => {
                return Ok(CommandOutcome::frame(self.error_event_frame(
                    envelope.seq,
                    format!("turn-error-{turn_id}"),
                    envelope.correlation_id,
                    self.current_generation().to_owned(),
                    "runtime-spawn-failed",
                    &error.to_string(),
                )?));
            }
        };

        Ok(CommandOutcome {
            frames: vec![
                self.response_frame(
                    &envelope,
                    ResponsePayload::Session(SessionResult::Accepted(CommandAccepted {
                        accepted: true,
                    })),
                )?,
                self.session_event_frame(SessionEventSpec {
                    seq: envelope.seq,
                    message_id: format!("turn-completed-{turn_id}"),
                    correlation_id: envelope.correlation_id,
                    generation_id: self.current_generation().to_owned(),
                    session_id: Some(session_id),
                    turn_id: Some(turn_id),
                    kind: "turn-completed".to_owned(),
                    data: json!({ "leaseId": lease_id, "output": output }),
                })?,
            ],
            exit_code: None,
            disposition: MutationDisposition::Executed,
        })
    }

    fn start_managed_host(&self) -> Result<Vec<String>, MainError> {
        materialize_host_patch(
            &self.host_patch_template,
            &self.managed_host_patch,
            &self.host_module,
        )?;
        let mut env = self.host_environment.clone();
        env.insert("DSH_TELEMETRY_DISABLED".to_owned(), "1".into());
        let spec = SpawnSpec {
            program: self.runtime_executable.clone(),
            args: vec![
                "--profile".to_owned(),
                "headless".to_owned(),
                "--patch".to_owned(),
                self.managed_host_patch.to_string_lossy().into_owned(),
            ],
            current_dir: Some(self.dsh_home.clone()),
            env,
        };
        fs::create_dir_all(&self.dsh_home)?;
        let response = self.supervisor.start_host(
            spec,
            &json!({ "id": 0, "method": "initialize", "params": {} }).to_string(),
        )?;
        let value: serde_json::Value = serde_json::from_str(&response).map_err(|error| {
            MainError::Config(format!("invalid Host initialize response: {error}"))
        })?;
        if value.get("type").and_then(serde_json::Value::as_str) != Some("result")
            || value
                .pointer("/data/state")
                .and_then(serde_json::Value::as_str)
                != Some("ready")
        {
            return Err(MainError::Config(format!(
                "Host did not reach ready: {}",
                self.redaction.redact_text(&response)
            )));
        }
        let capabilities = value
            .pointer("/data/capabilities")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| MainError::Config("Host ready omitted capabilities".to_owned()))?
            .iter()
            .filter_map(|entry| {
                entry
                    .get("capabilityId")
                    .and_then(serde_json::Value::as_str)
            })
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if capabilities.is_empty() {
            return Err(MainError::Config(
                "Host ready advertised no capabilities".to_owned(),
            ));
        }
        Ok(capabilities)
    }

    fn host_result(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, MainError> {
        let id = self.next_wire_error_id;
        self.next_wire_error_id = self.next_wire_error_id.saturating_add(1);
        let response = self
            .supervisor
            .host_request(&json!({ "id": id, "method": method, "params": params }).to_string())?;
        let value: serde_json::Value = serde_json::from_str(&response)
            .map_err(|error| MainError::Config(format!("invalid Host response: {error}")))?;
        if value.get("type").and_then(serde_json::Value::as_str) != Some("result") {
            return Err(MainError::Config(format!(
                "Host {method} failed: {}",
                self.redaction.redact_text(&response)
            )));
        }
        Ok(value
            .get("data")
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    }

    fn handle_host_snapshot(
        &mut self,
        envelope: Envelope<CommandPayload>,
        request: SnapshotRequest,
    ) -> Result<CommandOutcome, MainError> {
        let requested_session_id = request.session_id.clone();
        let data = self.host_result(
            "session.snapshot",
            json!({
                "sessionId": request.session_id,
                "domainGenerationId": self.current_generation(),
                "contractHash": DSH_CONTRACT_HASH,
            }),
        )?;
        let snapshot = aio_dsh_protocol::SessionSnapshot {
            domain_generation_id: required_json_string(&data, "domainGenerationId")?.to_owned(),
            contract_hash: required_json_string(&data, "contractHash")?.to_owned(),
            session_id: required_json_string(&data, "sessionId")?.to_owned(),
            cursor: required_json_string(&data, "cursor")?.to_owned(),
            seq: data
                .get("seq")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| MainError::Config("Host snapshot omitted seq".to_owned()))?,
            durable_facts: serde_json::from_value(data.get("durableFacts").cloned().ok_or_else(
                || MainError::Config("Host snapshot omitted durableFacts".to_owned()),
            )?)
            .map_err(|error| MainError::Config(format!("invalid Host durable facts: {error}")))?,
        };
        self.pending_interactions
            .retain(|_, interaction| interaction.session_id != requested_session_id);
        let mut frames = Vec::new();
        if let Some(interactions) = data
            .get("activeInteractions")
            .and_then(serde_json::Value::as_array)
        {
            for value in interactions {
                let correlation_id = required_json_string(value, "correlationId")?.to_owned();
                if self.resolved_interactions.contains(&correlation_id) {
                    continue;
                }
                let session_id = required_json_string(value, "sessionId")?.to_owned();
                let interaction = InteractionRequest {
                    domain_generation_id: self.current_generation().to_owned(),
                    contract_hash: DSH_CONTRACT_HASH.to_owned(),
                    session_id,
                    correlation_id: correlation_id.clone(),
                    kind: InteractionKind::Approval,
                    data: json!({
                        "turnId": value.get("turnId"),
                        "toolName": value.pointer("/data/toolName"),
                        "callId": value.pointer("/data/callId"),
                        "reason": value.pointer("/data/reason"),
                    }),
                };
                self.pending_interactions
                    .insert(correlation_id, interaction.clone());
                frames.push(self.interaction_request_frame(envelope.seq, interaction)?);
            }
        }
        frames.push(self.response_frame(
            &envelope,
            ResponsePayload::Session(SessionResult::Snapshot(snapshot)),
        )?);
        Ok(CommandOutcome::with_frames(frames))
    }

    fn configure_host_environment(&mut self, params: &serde_json::Value) -> Result<(), MainError> {
        let Some(provider) = params.get("provider") else {
            return Ok(());
        };
        let base_url = required_json_string(provider, "baseUrl")?;
        let api_key = required_json_string(provider, "apiKey")?;
        if !(base_url.starts_with("https://")
            || base_url.starts_with("http://127.0.0.1:")
            || base_url.starts_with("http://localhost:"))
        {
            return Err(MainError::Config(
                "provider baseUrl must use HTTPS or an explicit loopback origin".to_owned(),
            ));
        }
        self.host_environment
            .insert("DEEPSEEK_BASE_URL".to_owned(), base_url.into());
        self.host_environment
            .insert("DEEPSEEK_API_KEY".to_owned(), api_key.into());
        Ok(())
    }

    fn ensure_headless_runtime_patch(&self) -> Result<PathBuf, MainError> {
        fs::create_dir_all(&self.dsh_home)?;
        let path = self.dsh_home.join("aio-host-headless.patch.yml");
        if path.exists() {
            let existing = fs::read_to_string(&path)?;
            if existing != headless_runtime_patch_contents() {
                return Err(MainError::Config(
                    "managed headless runtime patch was modified".to_owned(),
                ));
            }
        } else {
            fs::write(&path, headless_runtime_patch_contents())?;
        }
        Ok(path)
    }

    fn handle_accepting_mutation(
        &mut self,
        envelope: Envelope<CommandPayload>,
        session_id: String,
        lease_id: String,
        turn_id: Option<String>,
        event_kind: &str,
    ) -> Result<CommandOutcome, MainError> {
        if let Some(rejected) =
            self.validate_controller_lease(&envelope, &session_id, &lease_id, turn_id.as_deref())?
        {
            return Ok(rejected);
        }

        Ok(CommandOutcome {
            frames: vec![
                self.response_frame(
                    &envelope,
                    ResponsePayload::Session(SessionResult::Accepted(CommandAccepted {
                        accepted: true,
                    })),
                )?,
                self.session_event_frame(SessionEventSpec {
                    seq: envelope.seq,
                    message_id: format!("{event_kind}-{session_id}"),
                    correlation_id: envelope.correlation_id,
                    generation_id: self.current_generation().to_owned(),
                    session_id: Some(session_id),
                    turn_id,
                    kind: event_kind.to_owned(),
                    data: json!({ "leaseId": lease_id }),
                })?,
            ],
            exit_code: None,
            disposition: MutationDisposition::Executed,
        })
    }

    fn validate_controller_lease(
        &self,
        envelope: &Envelope<CommandPayload>,
        session_id: &str,
        lease_id: &str,
        turn_id: Option<&str>,
    ) -> Result<Option<CommandOutcome>, MainError> {
        let Some(active) = self.controller_leases.get(session_id) else {
            return Ok(Some(self.reject_command(
                envelope,
                Some(session_id.to_owned()),
                Some(lease_id.to_owned()),
                turn_id.map(str::to_owned),
                "unknown-lease",
                "no controller lease exists for the requested session",
            )?));
        };

        if active.lease.lease_id != lease_id {
            return Ok(Some(self.reject_command(
                envelope,
                Some(session_id.to_owned()),
                Some(lease_id.to_owned()),
                turn_id.map(str::to_owned),
                "stale-lease",
                "leaseId does not match the active controller lease",
            )?));
        }

        Ok(None)
    }

    fn reject_command(
        &self,
        envelope: &Envelope<CommandPayload>,
        session_id: Option<String>,
        lease_id: Option<String>,
        turn_id: Option<String>,
        code: &str,
        message: &str,
    ) -> Result<CommandOutcome, MainError> {
        Ok(CommandOutcome::rejected(vec![
            self.response_frame(
                envelope,
                ResponsePayload::Session(SessionResult::Accepted(CommandAccepted {
                    accepted: false,
                })),
            )?,
            self.session_event_frame(SessionEventSpec {
                seq: envelope.seq,
                message_id: format!("{}:rejected", envelope.message_id),
                correlation_id: envelope.correlation_id.clone(),
                generation_id: self.current_generation().to_owned(),
                session_id,
                turn_id,
                kind: "command-rejected".to_owned(),
                data: json!({
                    "code": code,
                    "message": self.redaction.redact_text(message),
                    "leaseId": lease_id,
                    "receivedDomainGenerationId": envelope.domain_generation_id,
                }),
            })?,
        ]))
    }

    fn response_frame(
        &self,
        envelope: &Envelope<CommandPayload>,
        payload: ResponsePayload,
    ) -> Result<String, MainError> {
        self.response_frame_with_generation(
            envelope.seq,
            format!("{}:response", envelope.message_id),
            envelope.correlation_id.clone(),
            self.current_generation().to_owned(),
            payload,
        )
    }

    fn response_frame_with_generation(
        &self,
        seq: u64,
        message_id: String,
        correlation_id: Option<String>,
        generation_id: String,
        payload: ResponsePayload,
    ) -> Result<String, MainError> {
        serde_json::to_string(&ResponseEnvelope(Envelope {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            contract_hash: DSH_CONTRACT_HASH.to_owned(),
            domain_generation_id: generation_id,
            seq,
            message_id,
            correlation_id,
            payload,
        }))
        .map_err(|error| MainError::Config(error.to_string()))
    }

    fn wire_error_frame(
        &mut self,
        raw: &str,
        error: &serde_json::Error,
    ) -> Result<String, MainError> {
        let context = extract_wire_frame_context(raw);
        let base_message_id = context.message_id.unwrap_or_else(|| {
            let id = self.next_wire_error_id;
            self.next_wire_error_id = self.next_wire_error_id.saturating_add(1);
            format!("wire-error-{id}")
        });
        self.error_event_frame(
            context.seq,
            format!("{base_message_id}:error"),
            context.correlation_id,
            self.current_generation().to_owned(),
            "invalid-command-frame",
            &format!("command frame rejected: {error}"),
        )
    }

    fn is_interrupted_turn(&self, session_id: &str, turn_id: &str) -> bool {
        self.interrupted_turns.turns.contains(&InterruptedTurnKey {
            session_id: session_id.to_owned(),
            turn_id: turn_id.to_owned(),
        })
    }

    fn record_interrupted_turn(
        &mut self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<(), MainError> {
        let inserted = self.interrupted_turns.turns.insert(InterruptedTurnKey {
            session_id: session_id.to_owned(),
            turn_id: turn_id.to_owned(),
        });
        if !inserted {
            return Ok(());
        }

        if let Some(parent) = self.interrupted_turns_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let serialized = serde_json::to_vec(&self.interrupted_turns)
            .map_err(|error| MainError::Config(error.to_string()))?;
        // Crash recovery depends on this ledger never being torn: write to a
        // sibling temp file and atomically replace the live one.
        let temp_path = self.interrupted_turns_path.with_extension("json.tmp");
        fs::write(&temp_path, serialized)?;
        fs::rename(&temp_path, &self.interrupted_turns_path)?;
        Ok(())
    }

    fn state_frame(
        &self,
        seq: u64,
        message_id: String,
        correlation_id: Option<String>,
        generation_id: String,
        state: RuntimeState,
    ) -> Result<String, MainError> {
        serde_json::to_string(&NotificationEnvelope(Envelope {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            contract_hash: DSH_CONTRACT_HASH.to_owned(),
            domain_generation_id: generation_id,
            seq,
            message_id,
            correlation_id,
            payload: NotificationPayload::State(RuntimeStateNotification { state }),
        }))
        .map_err(|error| MainError::Config(error.to_string()))
    }

    fn error_event_frame(
        &self,
        seq: u64,
        message_id: String,
        correlation_id: Option<String>,
        generation_id: String,
        code: &str,
        message: &str,
    ) -> Result<String, MainError> {
        self.session_event_frame(SessionEventSpec {
            seq,
            message_id,
            correlation_id,
            generation_id,
            session_id: None,
            turn_id: None,
            kind: "error".to_owned(),
            data: json!({
                "code": code,
                "message": self.redaction.redact_text(message),
            }),
        })
    }

    fn session_event_frame(&self, event: SessionEventSpec) -> Result<String, MainError> {
        serde_json::to_string(&NotificationEnvelope(Envelope {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            contract_hash: DSH_CONTRACT_HASH.to_owned(),
            domain_generation_id: event.generation_id,
            seq: event.seq,
            message_id: event.message_id,
            correlation_id: event.correlation_id,
            payload: NotificationPayload::Session(SessionNotification::Event(RuntimeEvent {
                kind: event.kind,
                session_id: event.session_id,
                turn_id: event.turn_id,
                data: event.data,
            })),
        }))
        .map_err(|error| MainError::Config(error.to_string()))
    }

    fn interaction_request_frame(
        &self,
        seq: u64,
        request: InteractionRequest,
    ) -> Result<String, MainError> {
        serde_json::to_string(&NotificationEnvelope(Envelope {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            contract_hash: DSH_CONTRACT_HASH.to_owned(),
            domain_generation_id: self.current_generation().to_owned(),
            seq,
            message_id: format!("interaction:{}", request.correlation_id),
            correlation_id: Some(request.correlation_id.clone()),
            payload: NotificationPayload::Interaction(request),
        }))
        .map_err(|error| MainError::Config(error.to_string()))
    }

    fn interaction_resolved_frame(
        &self,
        seq: u64,
        correlation_id: Option<String>,
        resolved: InteractionResolved,
    ) -> Result<String, MainError> {
        serde_json::to_string(&NotificationEnvelope(Envelope {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            contract_hash: DSH_CONTRACT_HASH.to_owned(),
            domain_generation_id: self.current_generation().to_owned(),
            seq,
            message_id: format!("interaction-resolved:{}", resolved.correlation_id),
            correlation_id,
            payload: NotificationPayload::InteractionResolved(resolved),
        }))
        .map_err(|error| MainError::Config(error.to_string()))
    }

    fn issue_lease(&self, session_id: String, mode: LeaseMode) -> ControllerLease {
        let id = self.next_lease_id.fetch_add(1, Ordering::Relaxed);
        ControllerLease {
            domain_generation_id: self.current_generation().to_owned(),
            contract_hash: DSH_CONTRACT_HASH.to_owned(),
            session_id,
            lease_id: format!("lease-{id}"),
            mode,
        }
    }

    fn current_generation(&self) -> &str {
        self.lifecycle
            .domain_generation_id()
            .unwrap_or("connection-stopped")
    }
    fn should_crash(&self, input: &serde_json::Value) -> bool {
        let Some(expected) = self.crash_token.as_deref() else {
            return false;
        };
        input
            .get("crashToken")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|token| token == expected)
    }
}

fn interrupted_turns_path(plugin_data_dir: &std::path::Path) -> PathBuf {
    plugin_data_dir
        .join("runtime")
        .join(INTERRUPTED_TURN_LEDGER_FILE)
}

fn resident_session_command(
    method: &str,
    params: &serde_json::Value,
    command_id: u64,
) -> Result<SessionCommand, String> {
    let session_id = required_host_param(params, "sessionId")?;
    // Hosts that predate explicit request identity fall back to a stable,
    // sequence-derived identity. True exactly-once semantics for retransmitted
    // mutations are enforced separately by the MutationLedger, which dedupes
    // by requestId (including this fallback) after capability, generation and
    // lease fencing.
    let fallback_request_id = params
        .get("requestId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("host-command-{command_id}"));
    match method {
        "session.acquire" => {
            let view_id = params
                .get("viewId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("host")
                .to_owned();
            let requested_mode = match params
                .get("mode")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("controller")
            {
                "controller" => LeaseMode::Controller,
                "observer" => LeaseMode::Observer,
                other => return Err(format!("unsupported lease mode {other}")),
            };
            Ok(SessionCommand::Acquire(AcquireSessionRequest {
                request_id: fallback_request_id,
                session_id,
                view_id,
                requested_mode,
            }))
        }
        "session.submitPrompt" => {
            let turn_id = required_host_param(params, "turnId")?;
            Ok(SessionCommand::SubmitPrompt(SubmitPromptRequest {
                request_id: fallback_request_id,
                session_id,
                lease_id: required_host_param(params, "leaseId")?,
                turn_id,
                input: params.get("input").cloned().unwrap_or_else(|| json!({})),
            }))
        }
        "session.steer" => Ok(SessionCommand::Steer(SteerRequest {
            request_id: fallback_request_id,
            session_id,
            lease_id: required_host_param(params, "leaseId")?,
            turn_id: required_host_param(params, "turnId")?,
            input: params.get("input").cloned().unwrap_or_else(|| json!({})),
        })),
        "session.cancel" => Ok(SessionCommand::Cancel(CancelRequest {
            request_id: fallback_request_id,
            session_id,
            lease_id: required_host_param(params, "leaseId")?,
            turn_id: required_host_param(params, "turnId")?,
        })),
        "session.transferController" => Ok(SessionCommand::TransferController(
            TransferControllerRequest {
                request_id: fallback_request_id,
                session_id,
                lease_id: required_host_param(params, "leaseId")?,
                target_view_id: required_host_param(params, "targetViewId")?,
            },
        )),
        "session.snapshot" => Ok(SessionCommand::Snapshot(SnapshotRequest {
            session_id,
            cursor: params
                .get("cursor")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
        })),
        other => Err(format!("unsupported resident Sidecar method {other}")),
    }
}

fn resident_interaction_response(
    params: &serde_json::Value,
    domain_generation_id: &str,
) -> Result<InteractionResponse, String> {
    let decision = match required_host_param(params, "decision")?.as_str() {
        "allow" | "allow-once" => InteractionDecision::Allow,
        "deny" => InteractionDecision::Deny,
        "answer" => InteractionDecision::Answer,
        "cancel" => InteractionDecision::Cancel,
        "timeout" => InteractionDecision::Timeout,
        other => return Err(format!("unsupported interaction decision {other}")),
    };
    Ok(InteractionResponse {
        domain_generation_id: domain_generation_id.to_owned(),
        session_id: required_host_param(params, "sessionId")?,
        lease_id: required_host_param(params, "leaseId")?,
        correlation_id: required_host_param(params, "correlationId")?,
        decision,
        data: params.get("data").cloned(),
    })
}

fn host_interaction_decision(decision: &InteractionDecision) -> &'static str {
    match decision {
        InteractionDecision::Allow => "allow",
        InteractionDecision::Deny => "deny",
        InteractionDecision::Cancel => "cancel",
        InteractionDecision::Timeout => "timeout",
        InteractionDecision::Answer => "answer",
    }
}

fn required_host_param(params: &serde_json::Value, name: &str) -> Result<String, String> {
    params
        .get(name)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("missing required resident Sidecar param {name}"))
}

fn required_json_string(value: &serde_json::Value, name: &str) -> Result<String, MainError> {
    value
        .get(name)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| MainError::Config(format!("missing required coding turn field {name}")))
}

fn headless_runtime_patch_contents() -> &'static str {
    "- id: session-title-llm\n  disabled: true\n"
}

fn load_interrupted_turns(path: &std::path::Path) -> Result<InterruptedTurnLedger, MainError> {
    match fs::read(path) {
        Ok(bytes) => {
            match serde_json::from_slice(&bytes) {
                Ok(ledger) => Ok(ledger),
                Err(error) => {
                    // A torn or corrupted ledger must not brick the whole
                    // domain. Quarantine it for operator inspection and start
                    // with an empty ledger instead.
                    let quarantine_path = path.with_extension("json.corrupt");
                    let _ = fs::remove_file(&quarantine_path);
                    fs::rename(path, &quarantine_path)?;
                    let _ = writeln!(
                        io::stderr(),
                        "{}",
                        RedactionPolicy::default().redact_text(&format!(
                            "interrupted-turn ledger was corrupt ({error}); quarantined to {}",
                            quarantine_path.display()
                        ))
                    );
                    Ok(InterruptedTurnLedger::default())
                }
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(InterruptedTurnLedger::default())
        }
        Err(error) => Err(MainError::Io(error)),
    }
}

fn extract_wire_frame_context(raw: &str) -> WireFrameContext {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return WireFrameContext::default();
    };

    WireFrameContext {
        seq: value
            .get("seq")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default(),
        message_id: value
            .get("messageId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        correlation_id: value
            .get("correlationId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
    }
}

fn required_runtime_files(platform: PlatformTarget) -> &'static [&'static str] {
    match platform {
        PlatformTarget::Win32X64 => &[
            "deepseek-harness-sdk-runtime-win-x64.exe",
            "deepseek-harness-sdk-runtime-win-x64-rg.exe",
        ],
        PlatformTarget::LinuxX64 => &[
            "deepseek-harness-sdk-runtime-linux-x64",
            "deepseek-harness-sdk-runtime-linux-x64-rg",
        ],
        PlatformTarget::DarwinArm64 => &[
            "deepseek-harness-sdk-runtime-macos-arm64",
            "deepseek-harness-sdk-runtime-macos-arm64-rg",
        ],
        PlatformTarget::LinuxArm64 => &[
            "deepseek-harness-sdk-runtime-linux-arm64",
            "deepseek-harness-sdk-runtime-linux-arm64-rg",
        ],
    }
}

fn session_id_for_command(command: &SessionCommand) -> Option<String> {
    match command {
        SessionCommand::Acquire(request) => Some(request.session_id.clone()),
        SessionCommand::TransferController(request) => Some(request.session_id.clone()),
        SessionCommand::SubmitPrompt(request) => Some(request.session_id.clone()),
        SessionCommand::Cancel(request) => Some(request.session_id.clone()),
        SessionCommand::Steer(request) => Some(request.session_id.clone()),
        SessionCommand::Snapshot(request) => Some(request.session_id.clone()),
    }
}

fn lease_id_for_command(command: &SessionCommand) -> Option<String> {
    match command {
        SessionCommand::Acquire(_) | SessionCommand::Snapshot(_) => None,
        SessionCommand::TransferController(request) => Some(request.lease_id.clone()),
        SessionCommand::SubmitPrompt(request) => Some(request.lease_id.clone()),
        SessionCommand::Cancel(request) => Some(request.lease_id.clone()),
        SessionCommand::Steer(request) => Some(request.lease_id.clone()),
    }
}

fn turn_id_for_command(command: &SessionCommand) -> Option<String> {
    match command {
        SessionCommand::Acquire(_)
        | SessionCommand::TransferController(_)
        | SessionCommand::Snapshot(_) => None,
        SessionCommand::SubmitPrompt(request) => Some(request.turn_id.clone()),
        SessionCommand::Cancel(request) => Some(request.turn_id.clone()),
        SessionCommand::Steer(request) => Some(request.turn_id.clone()),
    }
}

#[cfg(test)]
mod host_runtime_patch_tests {
    use super::headless_runtime_patch_contents;

    #[test]
    fn disables_only_the_optional_session_title_provider() {
        let patch = headless_runtime_patch_contents();
        assert!(patch.contains("id: session-title-llm"));
        assert!(patch.contains("disabled: true"));
        assert_eq!(patch.lines().count(), 2);
    }
}
