use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use aio_dsh_protocol::{
    CURRENT_PROTOCOL_VERSION, CommandAccepted, CommandEnvelope, CommandPayload, ControllerLease,
    Envelope, LeaseMode, NotificationEnvelope, NotificationPayload, PlatformFacts, PlatformKey,
    ResponseEnvelope, ResponsePayload, RuntimeEvent, RuntimeProvenance, RuntimeState,
    RuntimeStateNotification, SandboxBackend, SandboxLevel, SandboxStatus, SessionCommand,
    SessionNotification, SessionResult,
};
use aio_dsh_supervisor::{
    PlatformTarget, RedactionPolicy, Supervisor, SupervisorConfig,
    lifecycle::{LifecycleEvent, LifecycleMachine},
    runtime::DSH_CONTRACT_HASH,
    supervisor::SupervisorError,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

const DEFAULT_PLATFORM: &str = "win32-x64";
const DEFAULT_HOST_API_VERSION: u16 = 3;
const CRASH_EXIT_CODE: u8 = 86;

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
    let platform = config.platform;
    let interrupted_turns_path = interrupted_turns_path(&config.plugin_data_dir);
    let supervisor = Supervisor::new(config)?;
    let mut driver = StdioDriver::new(
        supervisor,
        platform,
        redaction,
        std::env::var(ENV_CRASH_TOKEN).ok(),
        interrupted_turns_path,
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
            version: "0.1.2-alpha.5".to_owned(),
            build_id: "resident-sidecar".to_owned(),
            source_revision: Some(aio_dsh_supervisor::runtime::DSH_COMMIT.to_owned()),
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

struct CommandOutcome {
    frames: Vec<String>,
    exit_code: Option<u8>,
}

impl CommandOutcome {
    fn frame(frame: String) -> Self {
        Self {
            frames: vec![frame],
            exit_code: None,
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
    interrupted_turns_path: PathBuf,
    interrupted_turns: InterruptedTurnLedger,
    next_lease_id: AtomicU64,
    next_wire_error_id: u64,
    initialized: bool,
}

impl StdioDriver {
    fn new(
        supervisor: Supervisor,
        platform: PlatformTarget,
        redaction: RedactionPolicy,
        crash_token: Option<String>,
        interrupted_turns_path: PathBuf,
    ) -> Result<Self, MainError> {
        Ok(Self {
            supervisor,
            platform,
            lifecycle: LifecycleMachine::new(Duration::from_secs(600)),
            redaction,
            crash_token,
            controller_leases: BTreeMap::new(),
            interrupted_turns: load_interrupted_turns(&interrupted_turns_path)?,
            interrupted_turns_path,
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
        for frame in &outcome.frames {
            let value: serde_json::Value = serde_json::from_str(frame)
                .map_err(|parse_error| MainError::Config(parse_error.to_string()))?;
            let payload = &value["payload"];
            if payload["kind"] == "state" {
                state = payload["data"]["state"].as_str().map(str::to_owned);
            }
            if payload["kind"] == "session"
                && payload["data"]["kind"] == "event"
                && payload["data"]["data"]["kind"] == "error"
            {
                error = Some(payload["data"]["data"]["data"].clone());
            }
        }
        let frame = if let Some(error) = error {
            json!({ "id": id, "type": "error", "data": error })
        } else if let Some(state) = state {
            json!({
                "id": id,
                "type": "result",
                "data": {
                    "state": state,
                    "domainGenerationId": self.current_generation(),
                }
            })
        } else {
            json!({
                "id": id,
                "type": "error",
                "data": { "code": "resident-command-no-terminal-result" }
            })
        };
        Ok(CommandOutcome {
            frames: vec![frame.to_string()],
            exit_code: outcome.exit_code,
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
            CommandPayload::Interaction(response) => Ok(self.reject_command(
                &envelope,
                Some(response.session_id),
                Some(response.lease_id),
                None,
                "unsupported-interaction",
                "interaction responses are not available before the bridge is wired",
            )?),
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
            Ok(_) => {
                self.initialized = true;
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

        match command {
            SessionCommand::Acquire(request) => self.handle_acquire(envelope, request),
            SessionCommand::TransferController(request) => self.handle_transfer(
                envelope,
                request.session_id,
                request.lease_id,
                request.target_view_id,
            ),
            SessionCommand::SubmitPrompt(request) => self.handle_submit_like(
                envelope,
                request.session_id,
                request.lease_id,
                request.turn_id,
                request.input,
                "submit-prompt",
            ),
            SessionCommand::Cancel(request) => self.handle_accepting_mutation(
                envelope,
                request.session_id,
                request.lease_id,
                Some(request.turn_id),
                "cancel-requested",
            ),
            SessionCommand::Steer(request) => self.handle_submit_like(
                envelope,
                request.session_id,
                request.lease_id,
                request.turn_id,
                request.input,
                "steer",
            ),
            SessionCommand::Snapshot(request) => Ok(CommandOutcome::frame(self.response_frame(
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
            )?)),
        }
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
            });
        }

        self.handle_accepting_mutation(envelope, session_id, lease_id, Some(turn_id), event_kind)
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
        Ok(CommandOutcome {
            frames: vec![
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
            ],
            exit_code: None,
        })
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
