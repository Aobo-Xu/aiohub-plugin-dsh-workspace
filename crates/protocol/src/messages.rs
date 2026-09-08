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
    Host(HostCommand),
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
    Host(HostResult),
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
    pub backend: SandboxBackend,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxBackend {
    Bwrap,
    Landlock,
    Seatbelt,
    RestrictedToken,
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
    pub capabilities: Vec<CapabilityDescriptor>,
    pub operations: Vec<OperationAvailability>,
}

impl InitializeResult {
    /// Typed availability for one capability id. Returns `None` when the
    /// contract does not know the operation at all; known but un-negotiated
    /// operations report `available: false` with a typed reason.
    pub fn availability(&self, capability_id: &str) -> Option<OperationAvailability> {
        self.operations
            .iter()
            .find(|operation| operation.capability_id == capability_id)
            .cloned()
    }
}

/// Stability class of a capability, mirroring the stable/experimental split
/// of the negotiated capability strings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityStability {
    Stable,
    Experimental,
}

/// Access mode an operation requires on the session state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum OperationMode {
    Read,
    Mutate,
    Observe,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityDescriptor {
    pub capability_id: String,
    pub schema_revision: u16,
    pub stability: CapabilityStability,
    pub mode: OperationMode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationAvailability {
    pub capability_id: String,
    pub schema_revision: u16,
    pub available: bool,
    pub mode: OperationMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<UnavailableReason>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum UnavailableReason {
    #[serde(rename_all = "camelCase")]
    NotNegotiated { message_key: String },
    #[serde(rename_all = "camelCase")]
    EnvironmentUnsupported { message_key: String },
    #[serde(rename_all = "camelCase")]
    TemporarilyUnavailable { message_key: String },
}

const NOT_NEGOTIATED_MESSAGE_KEY: &str = "capability.not-negotiated";

/// Catalog of every operation the contract knows about, paired with the
/// stable capability that must be negotiated before the operation becomes
/// available. Entries without a capability are part of the contract but not
/// attached to a negotiable capability yet; they are reported as unavailable
/// with `UnavailableReason::NotNegotiated`.
fn capability_catalog() -> impl Iterator<Item = (Option<&'static str>, CapabilityDescriptor)> {
    fn descriptor(
        capability_id: &'static str,
        stability: CapabilityStability,
        mode: OperationMode,
    ) -> CapabilityDescriptor {
        CapabilityDescriptor {
            capability_id: capability_id.to_owned(),
            // Every catalog operation is introduced by the current contract
            // revision; bump the revision of one capability when its payload
            // schema changes instead of guessing a shared version number.
            schema_revision: 1,
            stability,
            mode,
        }
    }

    [
        (
            Some("session"),
            descriptor(
                "session.acquire",
                CapabilityStability::Stable,
                OperationMode::Mutate,
            ),
        ),
        (
            Some("session"),
            descriptor(
                "session.transfer-controller",
                CapabilityStability::Stable,
                OperationMode::Mutate,
            ),
        ),
        (
            Some("session"),
            descriptor(
                "session.submit-prompt",
                CapabilityStability::Stable,
                OperationMode::Mutate,
            ),
        ),
        (
            Some("session"),
            descriptor(
                "session.cancel",
                CapabilityStability::Stable,
                OperationMode::Mutate,
            ),
        ),
        (
            Some("session"),
            descriptor(
                "session.steer",
                CapabilityStability::Stable,
                OperationMode::Mutate,
            ),
        ),
        (
            Some("session"),
            descriptor(
                "session.snapshot",
                CapabilityStability::Stable,
                OperationMode::Read,
            ),
        ),
        (
            None,
            descriptor(
                "session.archive",
                CapabilityStability::Experimental,
                OperationMode::Read,
            ),
        ),
    ]
    .into_iter()
}

fn negotiated_capabilities(negotiated_stable: &BTreeSet<String>) -> Vec<CapabilityDescriptor> {
    capability_catalog()
        .filter(|(required, _)| {
            required.is_some_and(|capability| negotiated_stable.contains(capability))
        })
        .map(|(_, descriptor)| descriptor)
        .collect()
}

fn negotiated_operations(negotiated_stable: &BTreeSet<String>) -> Vec<OperationAvailability> {
    capability_catalog()
        .map(|(required, descriptor)| {
            let available =
                required.is_some_and(|capability| negotiated_stable.contains(capability));
            OperationAvailability {
                capability_id: descriptor.capability_id,
                schema_revision: descriptor.schema_revision,
                available,
                mode: descriptor.mode,
                reason: (!available).then(|| UnavailableReason::NotNegotiated {
                    message_key: NOT_NEGOTIATED_MESSAGE_KEY.to_owned(),
                }),
            }
        })
        .collect()
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
    let negotiated_stable: BTreeSet<String> =
        local_stable.intersection(&remote_stable).cloned().collect();

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
        stable_capabilities: negotiated_stable.iter().cloned().collect(),
        experimental_capabilities: local_experimental
            .intersection(&remote_experimental)
            .cloned()
            .collect(),
        capabilities: negotiated_capabilities(&negotiated_stable),
        operations: negotiated_operations(&negotiated_stable),
    })
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, thiserror::Error)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum ProtocolError {
    #[error("incompatible protocol contract")]
    IncompatibleContract { issues: Vec<CompatibilityIssue> },
    #[error("host operation failed")]
    #[schemars(schema_with = "host_error_content_schema")]
    Host(HostError),
}

/// Content schema for `ProtocolError::Host`. Adjacent-tagged content slots
/// carry the full closed payload schema inline so validating an error never
/// depends on reference resolution; the named `$defs.HostError` entry is kept
/// registered so consumers can still reference it.
fn host_error_content_schema(generator: &mut SchemaGenerator) -> Schema {
    let _named_definition = generator.subschema_for::<HostError>();
    <HostError as JsonSchema>::json_schema(generator)
}

/// Typed host-side failure reported through `ProtocolError::Host`. The `code`
/// identifies the failure class; consumers must never derive it from message
/// text. `indeterminate` marks operations whose outcome is unknown (for
/// example after a lost connection), independently of `retryable`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostError {
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_id: Option<String>,
    pub retryable: bool,
    pub indeterminate: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum HostCommand {
    Read(HostReadRequest),
    Mutate(HostMutationRequest),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum HostReadOperation {
    #[serde(rename = "workspace.list")]
    WorkspaceList,
    #[serde(rename = "workspace.open")]
    WorkspaceOpen,
    #[serde(rename = "session.list")]
    SessionList,
    #[serde(rename = "session.open")]
    SessionOpen,
    #[serde(rename = "session.search")]
    SessionSearch,
    #[serde(rename = "session.history")]
    SessionHistory,
    #[serde(rename = "terminal.read")]
    TerminalRead,
    #[serde(rename = "terminal.list")]
    TerminalList,
    #[serde(rename = "preset.catalog")]
    PresetCatalog,
    #[serde(rename = "dynamic.host.inventory")]
    DynamicHostInventory,
    #[serde(rename = "dynamic.host.diagnostics")]
    DynamicHostDiagnostics,
    #[serde(rename = "attachment.limits")]
    AttachmentLimits,
    #[serde(rename = "context.summary")]
    ContextSummary,
}

impl HostReadOperation {
    pub const fn method(self) -> &'static str {
        match self {
            Self::WorkspaceList => "workspace.list",
            Self::WorkspaceOpen => "workspace.open",
            Self::SessionList => "session.list",
            Self::SessionOpen => "session.open",
            Self::SessionSearch => "session.search",
            Self::SessionHistory => "session.history",
            Self::TerminalRead => "terminal.read",
            Self::TerminalList => "terminal.list",
            Self::PresetCatalog => "preset.catalog",
            Self::DynamicHostInventory => "dynamic.host.inventory",
            Self::DynamicHostDiagnostics => "dynamic.host.diagnostics",
            Self::AttachmentLimits => "attachment.limits",
            Self::ContextSummary => "context.summary",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum HostMutationOperation {
    #[serde(rename = "workspace.create")]
    WorkspaceCreate,
    #[serde(rename = "workspace.rename")]
    WorkspaceRename,
    #[serde(rename = "workspace.remove")]
    WorkspaceRemove,
    #[serde(rename = "workspace.archiveSession")]
    WorkspaceArchiveSession,
    #[serde(rename = "session.create")]
    SessionCreate,
    #[serde(rename = "session.resume")]
    SessionResume,
    #[serde(rename = "session.rename")]
    SessionRename,
    #[serde(rename = "session.restoreArchive")]
    SessionRestoreArchive,
    #[serde(rename = "session.delete")]
    SessionDelete,
    #[serde(rename = "session.fork")]
    SessionFork,
    #[serde(rename = "session.updateQueue")]
    SessionUpdateQueue,
    #[serde(rename = "session.restart")]
    SessionRestart,
    #[serde(rename = "terminal.open")]
    TerminalOpen,
    #[serde(rename = "terminal.input")]
    TerminalInput,
    #[serde(rename = "terminal.resize")]
    TerminalResize,
    #[serde(rename = "terminal.interrupt")]
    TerminalInterrupt,
    #[serde(rename = "terminal.close")]
    TerminalClose,
    #[serde(rename = "preset.select")]
    PresetSelect,
    #[serde(rename = "dynamic.host.define")]
    DynamicHostDefine,
    #[serde(rename = "dynamic.host.run")]
    DynamicHostRun,
    #[serde(rename = "dynamic.host.update")]
    DynamicHostUpdate,
    #[serde(rename = "dynamic.host.stop")]
    DynamicHostStop,
    #[serde(rename = "dynamic.host.undefine")]
    DynamicHostUndefine,
}

impl HostMutationOperation {
    pub const fn method(self) -> &'static str {
        match self {
            Self::WorkspaceCreate => "workspace.create",
            Self::WorkspaceRename => "workspace.rename",
            Self::WorkspaceRemove => "workspace.remove",
            Self::WorkspaceArchiveSession => "workspace.archiveSession",
            Self::SessionCreate => "session.create",
            Self::SessionResume => "session.resume",
            Self::SessionRename => "session.rename",
            Self::SessionRestoreArchive => "session.restoreArchive",
            Self::SessionDelete => "session.delete",
            Self::SessionFork => "session.fork",
            Self::SessionUpdateQueue => "session.updateQueue",
            Self::SessionRestart => "session.restart",
            Self::TerminalOpen => "terminal.open",
            Self::TerminalInput => "terminal.input",
            Self::TerminalResize => "terminal.resize",
            Self::TerminalInterrupt => "terminal.interrupt",
            Self::TerminalClose => "terminal.close",
            Self::PresetSelect => "preset.select",
            Self::DynamicHostDefine => "dynamic.host.define",
            Self::DynamicHostRun => "dynamic.host.run",
            Self::DynamicHostUpdate => "dynamic.host.update",
            Self::DynamicHostStop => "dynamic.host.stop",
            Self::DynamicHostUndefine => "dynamic.host.undefine",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostReadRequest {
    pub operation: HostReadOperation,
    pub input: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostMutationRequest {
    pub operation: HostMutationOperation,
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<String>,
    pub input: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostResult {
    pub operation: String,
    pub value: Value,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcquireSessionRequest {
    /// Caller-chosen identity that makes the mutation idempotent across
    /// retries; duplicates must not repeat the lease transition.
    pub request_id: String,
    pub session_id: String,
    pub view_id: String,
    pub requested_mode: LeaseMode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferControllerRequest {
    /// Caller-chosen identity that makes the mutation idempotent across
    /// retries; duplicates must not repeat the controller transfer.
    pub request_id: String,
    pub session_id: String,
    pub lease_id: String,
    pub target_view_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmitPromptRequest {
    /// Caller-chosen identity that makes the mutation idempotent across
    /// retries; duplicate request ids for the same turn must not resubmit.
    pub request_id: String,
    pub session_id: String,
    pub lease_id: String,
    pub turn_id: String,
    pub input: Value,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelRequest {
    /// Caller-chosen identity that makes the mutation idempotent across
    /// retries; duplicates must not repeat the cancellation.
    pub request_id: String,
    pub session_id: String,
    pub lease_id: String,
    pub turn_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SteerRequest {
    /// Caller-chosen identity that makes the mutation idempotent across
    /// retries; duplicates must not repeat the steering update.
    pub request_id: String,
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
    Loading,
    Ready,
    Maintenance,
    Upgrading,
    Recovering,
    Busy,
    Stopping,
    Crashed,
    Unavailable,
    Incompatible,
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
