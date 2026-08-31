use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::borrow::Cow;
use std::collections::BTreeSet;

use crate::CONTRACT_HASH;

pub const CURRENT_PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion { major: 1, minor: 0 };

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtocolVersion {
    pub major: u16,
    pub minor: u16,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Envelope<T> {
    pub protocol_version: ProtocolVersion,
    pub contract_hash: String,
    pub domain_generation_id: String,
    pub seq: u64,
    pub message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    pub payload: T,
}

impl<T> Envelope<T> {
    pub fn new(domain_generation_id: impl Into<String>, seq: u64, payload: T) -> Self {
        Self {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            contract_hash: CONTRACT_HASH.to_owned(),
            domain_generation_id: domain_generation_id.into(),
            seq,
            message_id: format!("message-{seq}"),
            correlation_id: None,
            payload,
        }
    }

    pub fn with_correlation_id(mut self, correlation_id: impl Into<String>) -> Self {
        self.correlation_id = Some(correlation_id.into());
        self
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum CommandPayload {
    Initialize(InitializeRequest),
    Ping,
    Shutdown(ShutdownRequest),
    Session(SessionCommand),
    Interaction(InteractionResponse),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum ResponsePayload {
    Initialize(InitializeResult),
    Pong(PongResult),
    Shutdown(ShutdownResult),
    Session(SessionResult),
    Error(ProtocolError),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum NotificationPayload {
    State(RuntimeStateNotification),
    Session(SessionNotification),
    Interaction(InteractionRequest),
    InteractionResolved(InteractionResolved),
    Overload(OverloadNotification),
    Resync(ResyncNotification),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum InteractionPayload {
    Request(InteractionRequest),
    Response(InteractionResponse),
    Resolved(InteractionResolved),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProvenance {
    pub component: String,
    pub version: String,
    pub build_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_revision: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformFacts {
    pub platform: PlatformKey,
    pub architecture: String,
    pub sandbox: SandboxStatus,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PlatformKey {
    Win32X64,
    LinuxX64,
    DarwinArm64,
    LinuxArm64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SandboxStatus {
    pub level: SandboxLevel,
    pub backend: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxLevel {
    Full,
    Partial,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitializeRequest {
    pub protocol_version: ProtocolVersion,
    pub contract_hash: String,
    pub runtime: RuntimeProvenance,
    pub platform: PlatformFacts,
    pub stable_capabilities: Vec<String>,
    pub required_stable_capabilities: Vec<String>,
    pub experimental_capabilities: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitializeResult {
    pub protocol_version: ProtocolVersion,
    pub contract_hash: String,
    pub runtime: RuntimeProvenance,
    pub platform: PlatformFacts,
    pub stable_capabilities: Vec<String>,
    pub experimental_capabilities: Vec<String>,
}

pub fn negotiate_initialize(
    local: &InitializeRequest,
    remote: &InitializeRequest,
) -> Result<InitializeResult, ProtocolError> {
    let local_stable: BTreeSet<_> = local.stable_capabilities.iter().cloned().collect();
    let remote_stable: BTreeSet<_> = remote.stable_capabilities.iter().cloned().collect();
    let mut issues = Vec::new();

    if local.protocol_version.major != remote.protocol_version.major {
        issues.push(CompatibilityIssue::MajorVersion {
            local: local.protocol_version.major,
            remote: remote.protocol_version.major,
        });
    }
    if local.contract_hash != remote.contract_hash {
        issues.push(CompatibilityIssue::ContractHash {
            local: local.contract_hash.clone(),
            remote: remote.contract_hash.clone(),
        });
    }

    let required: BTreeSet<_> = local
        .required_stable_capabilities
        .iter()
        .chain(&remote.required_stable_capabilities)
        .cloned()
        .collect();
    for capability in required {
        if !local_stable.contains(&capability) {
            issues.push(CompatibilityIssue::MissingStableCapability {
                endpoint: Endpoint::Local,
                capability: capability.clone(),
            });
        }
        if !remote_stable.contains(&capability) {
            issues.push(CompatibilityIssue::MissingStableCapability {
                endpoint: Endpoint::Remote,
                capability,
            });
        }
    }

    if !issues.is_empty() {
        return Err(ProtocolError::IncompatibleContract { issues });
    }

    let local_experimental: BTreeSet<_> = local.experimental_capabilities.iter().cloned().collect();
    let remote_experimental: BTreeSet<_> =
        remote.experimental_capabilities.iter().cloned().collect();

    Ok(InitializeResult {
        protocol_version: ProtocolVersion {
            major: local.protocol_version.major,
            minor: local
                .protocol_version
                .minor
                .min(remote.protocol_version.minor),
        },
        contract_hash: local.contract_hash.clone(),
        runtime: local.runtime.clone(),
        platform: local.platform.clone(),
        stable_capabilities: local_stable.intersection(&remote_stable).cloned().collect(),
        experimental_capabilities: local_experimental
            .intersection(&remote_experimental)
            .cloned()
            .collect(),
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, thiserror::Error)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum ProtocolError {
    #[error("incompatible protocol contract")]
    IncompatibleContract { issues: Vec<CompatibilityIssue> },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum CompatibilityIssue {
    MajorVersion {
        local: u16,
        remote: u16,
    },
    ContractHash {
        local: String,
        remote: String,
    },
    MissingStableCapability {
        endpoint: Endpoint,
        capability: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Endpoint {
    Local,
    Remote,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShutdownRequest {
    pub reason: ShutdownReason,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ShutdownReason {
    PluginDisabled,
    AioExit,
    UserStop,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShutdownResult {
    pub accepted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PongResult {
    pub seq: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum SessionCommand {
    Acquire(AcquireSessionRequest),
    TransferController(TransferControllerRequest),
    SubmitPrompt(SubmitPromptRequest),
    Cancel(CancelRequest),
    Steer(SteerRequest),
    Snapshot(SnapshotRequest),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcquireSessionRequest {
    pub session_id: String,
    pub view_id: String,
    pub requested_mode: LeaseMode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferControllerRequest {
    pub session_id: String,
    pub lease_id: String,
    pub target_view_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmitPromptRequest {
    pub session_id: String,
    pub lease_id: String,
    pub turn_id: String,
    pub input: Value,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelRequest {
    pub session_id: String,
    pub lease_id: String,
    pub turn_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SteerRequest {
    pub session_id: String,
    pub lease_id: String,
    pub turn_id: String,
    pub input: Value,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotRequest {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum LeaseMode {
    Controller,
    Observer,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControllerLease {
    pub domain_generation_id: String,
    pub contract_hash: String,
    pub session_id: String,
    pub lease_id: String,
    pub mode: LeaseMode,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum SessionResult {
    Lease(ControllerLease),
    Snapshot(SessionSnapshot),
    Accepted(CommandAccepted),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandAccepted {
    pub accepted: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSnapshot {
    pub domain_generation_id: String,
    pub contract_hash: String,
    pub session_id: String,
    pub cursor: String,
    pub seq: u64,
    pub durable_facts: Vec<RuntimeEvent>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeEvent {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub data: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum SessionNotification {
    Event(RuntimeEvent),
    Snapshot(SessionSnapshot),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractionRequest {
    pub domain_generation_id: String,
    pub contract_hash: String,
    pub session_id: String,
    pub correlation_id: String,
    pub kind: InteractionKind,
    pub data: Value,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum InteractionKind {
    Approval,
    Question,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractionResponse {
    pub domain_generation_id: String,
    pub session_id: String,
    pub lease_id: String,
    pub correlation_id: String,
    pub decision: InteractionDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum InteractionDecision {
    Allow,
    Deny,
    Answer,
    Cancel,
    Timeout,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractionResolved {
    pub domain_generation_id: String,
    pub contract_hash: String,
    pub session_id: String,
    pub correlation_id: String,
    pub reason: InteractionResolutionReason,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum InteractionResolutionReason {
    Answered,
    Cancelled,
    Transferred,
    Restarted,
    Timeout,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStateNotification {
    pub state: RuntimeState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeState {
    Stopped,
    Starting,
    Ready,
    Busy,
    Stopping,
    Crashed,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverloadNotification {
    pub queue: String,
    pub dropped_disposable: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResyncNotification {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CommandEnvelope(pub Envelope<CommandPayload>);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct InteractionEnvelope(pub Envelope<InteractionPayload>);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NotificationEnvelope(pub Envelope<NotificationPayload>);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ResponseEnvelope(pub Envelope<ResponsePayload>);

macro_rules! concrete_envelope_schema {
    ($envelope:ty, $payload:ty, $name:literal) => {
        impl JsonSchema for $envelope {
            fn schema_name() -> Cow<'static, str> {
                Cow::Borrowed($name)
            }

            fn json_schema(generator: &mut SchemaGenerator) -> Schema {
                <Envelope<$payload> as JsonSchema>::json_schema(generator)
            }
        }
    };
}

concrete_envelope_schema!(CommandEnvelope, CommandPayload, "CommandEnvelope");
concrete_envelope_schema!(
    InteractionEnvelope,
    InteractionPayload,
    "InteractionEnvelope"
);
concrete_envelope_schema!(
    NotificationEnvelope,
    NotificationPayload,
    "NotificationEnvelope"
);
concrete_envelope_schema!(ResponseEnvelope, ResponsePayload, "ResponseEnvelope");

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtocolSchema {
    pub command: CommandEnvelope,
    pub interaction: InteractionEnvelope,
    pub notification: NotificationEnvelope,
    pub response: ResponseEnvelope,
}
