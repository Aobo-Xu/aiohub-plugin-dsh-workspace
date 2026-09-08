use std::collections::BTreeSet;
use std::fs;

use aio_dsh_protocol::{
    CONTRACT_HASH, CapabilityDescriptor, CapabilityStability, CommandPayload, CompatibilityIssue,
    Endpoint, Envelope, HostCommand, HostError, HostMutationOperation, HostMutationRequest,
    HostReadOperation, HostReadRequest, InitializeRequest, InteractionKind, InteractionPayload,
    InteractionRequest, InteractionResolutionReason, InteractionResolved, NotificationPayload,
    OperationAvailability, OperationMode, OverloadNotification, PlatformFacts, PlatformKey,
    PongResult, ProtocolError, ProtocolVersion, ResponsePayload, RuntimeProvenance, RuntimeState,
    SandboxBackend, SandboxLevel, SandboxStatus, SessionCommand, UnavailableReason,
    negotiate_initialize,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn initialize_request(
    stable: &[&str],
    required_stable: &[&str],
    experimental: &[&str],
) -> InitializeRequest {
    InitializeRequest {
        protocol_version: ProtocolVersion { major: 1, minor: 0 },
        contract_hash: CONTRACT_HASH.to_owned(),
        runtime: RuntimeProvenance {
            component: "test-runtime".to_owned(),
            version: "1.2.3".to_owned(),
            build_id: "build-7".to_owned(),
            source_revision: Some("abc123".to_owned()),
        },
        platform: PlatformFacts {
            platform: PlatformKey::Win32X64,
            architecture: "x86_64".to_owned(),
            sandbox: SandboxStatus {
                level: SandboxLevel::Full,
                backend: SandboxBackend::RestrictedToken,
                reason: None,
            },
        },
        stable_capabilities: stable.iter().map(|value| (*value).to_owned()).collect(),
        required_stable_capabilities: required_stable
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
        experimental_capabilities: experimental
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
    }
}

#[test]
fn host_operations_are_typed_and_runtime_states_cover_maintenance_transitions() {
    let read = CommandPayload::Host(HostCommand::Read(HostReadRequest {
        operation: HostReadOperation::WorkspaceList,
        input: json!({}),
    }));
    assert_eq!(
        serde_json::to_value(read).expect("serialize host read"),
        json!({
            "kind": "host",
            "data": {
                "kind": "read",
                "data": { "operation": "workspace.list", "input": {} }
            }
        })
    );

    let mutation = CommandPayload::Host(HostCommand::Mutate(HostMutationRequest {
        operation: HostMutationOperation::SessionRestart,
        request_id: "request-1".to_owned(),
        session_id: Some("session-1".to_owned()),
        lease_id: Some("lease-1".to_owned()),
        input: json!({}),
    }));
    let encoded = serde_json::to_value(mutation).expect("serialize host mutation");
    assert_eq!(
        encoded["data"]["data"]["operation"],
        json!("session.restart")
    );
    assert_eq!(encoded["data"]["data"]["requestId"], json!("request-1"));

    for state in [
        RuntimeState::Loading,
        RuntimeState::Maintenance,
        RuntimeState::Upgrading,
        RuntimeState::Recovering,
        RuntimeState::Incompatible,
    ] {
        assert!(matches!(
            serde_json::to_value(state).expect("serialize runtime state"),
            Value::String(_)
        ));
    }
}

#[test]
fn envelope_is_camel_case_single_line_json_and_round_trips() {
    let frame = Envelope::new("generation-1", 7, CommandPayload::Ping);
    let line = serde_json::to_string(&frame).expect("serialize command envelope");
    let value: Value = serde_json::from_str(&line).expect("parse serialized envelope");

    assert_eq!(
        value,
        json!({
            "protocolVersion": { "major": 1, "minor": 0 },
            "contractHash": CONTRACT_HASH,
            "domainGenerationId": "generation-1",
            "seq": 7,
            "messageId": "message-7",
            "payload": { "kind": "ping" }
        })
    );
    assert!(!line.contains('\n'));
    assert_eq!(
        serde_json::from_str::<Envelope<CommandPayload>>(&line)
            .expect("round-trip command envelope"),
        frame
    );
}

#[test]
fn envelope_rejects_unknown_contract_fields() {
    let mut value = serde_json::to_value(Envelope::new("generation-1", 7, CommandPayload::Ping))
        .expect("serialize command envelope");
    value
        .as_object_mut()
        .expect("envelope object")
        .insert("unexpected".to_owned(), json!(true));

    assert!(serde_json::from_value::<Envelope<CommandPayload>>(value).is_err());
}

#[test]
fn initialize_request_rejects_unknown_contract_fields() {
    let mut value =
        serde_json::to_value(initialize_request(&["session"], &["session"], &["trace"]))
            .expect("serialize initialize request");
    value
        .as_object_mut()
        .expect("initialize request object")
        .insert("unexpected".to_owned(), json!(true));

    assert!(serde_json::from_value::<InitializeRequest>(value).is_err());
}

#[test]
fn sandbox_backend_rejects_unknown_wire_values() {
    let invalid = json!({
        "level": "full",
        "backend": "docker"
    });

    assert!(serde_json::from_value::<SandboxStatus>(invalid).is_err());
}

#[test]
fn sandbox_backends_use_exact_wire_values() {
    let cases = [
        (SandboxBackend::Bwrap, "bwrap"),
        (SandboxBackend::Landlock, "landlock"),
        (SandboxBackend::Seatbelt, "seatbelt"),
        (SandboxBackend::RestrictedToken, "restricted-token"),
    ];

    for (backend, expected) in cases {
        assert_eq!(serde_json::to_value(backend).unwrap(), json!(expected));
    }
}

#[test]
fn tagged_payloads_reject_unknown_outer_and_inline_fields() {
    assert!(
        serde_json::from_value::<CommandPayload>(json!({ "kind": "ping", "unexpected": true }))
            .is_err()
    );
    assert!(
        serde_json::from_value::<ResponsePayload>(json!({
            "kind": "pong",
            "data": { "seq": 1 },
            "unexpected": true
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<NotificationPayload>(json!({
            "kind": "state",
            "data": { "state": "ready" },
            "unexpected": true
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<InteractionPayload>(json!({
            "kind": "resolved",
            "data": {
                "domainGenerationId": "generation-1",
                "contractHash": CONTRACT_HASH,
                "sessionId": "session-1",
                "correlationId": "interaction-1",
                "reason": "answered"
            },
            "unexpected": true
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<CommandPayload>(json!({
            "kind": "session",
            "data": {
                "kind": "snapshot",
                "data": { "sessionId": "session-1" },
                "unexpected": true
            }
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<ProtocolError>(json!({
            "kind": "incompatible-contract",
            "data": { "issues": [], "unexpected": true }
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<CompatibilityIssue>(json!({
            "kind": "major-version",
            "data": { "local": 1, "remote": 1, "unexpected": true }
        }))
        .is_err()
    );
}

#[test]
fn explicitly_open_value_payloads_keep_unknown_business_fields() {
    let request = serde_json::from_value::<InteractionRequest>(json!({
        "domainGenerationId": "generation-1",
        "contractHash": CONTRACT_HASH,
        "sessionId": "session-1",
        "correlationId": "interaction-1",
        "kind": "question",
        "data": { "futureBusinessField": { "nested": true } }
    }))
    .expect("open interaction data remains extensible");

    assert_eq!(request.kind, InteractionKind::Question);
    assert_eq!(
        request.data,
        json!({ "futureBusinessField": { "nested": true } })
    );
}

#[test]
fn correlation_id_is_optional_and_uses_the_envelope_field_name() {
    let without = serde_json::to_value(Envelope::new("generation-1", 1, CommandPayload::Ping))
        .expect("serialize envelope without correlation");
    assert!(without.get("correlationId").is_none());

    let with = serde_json::to_value(
        Envelope::new("generation-1", 2, CommandPayload::Ping).with_correlation_id("request-1"),
    )
    .expect("serialize envelope with correlation");
    assert_eq!(with.get("correlationId"), Some(&json!("request-1")));
}

#[test]
fn command_payload_uses_adjacent_kebab_case_kind_and_data() {
    let initialize = initialize_request(&["session"], &["session"], &["trace"]);

    assert_eq!(
        serde_json::to_value(CommandPayload::Initialize(initialize.clone()))
            .expect("serialize initialize command"),
        json!({ "kind": "initialize", "data": initialize })
    );
    assert_eq!(
        serde_json::to_value(CommandPayload::Ping).expect("serialize ping command"),
        json!({ "kind": "ping" })
    );
}

#[test]
fn response_payload_uses_adjacent_kebab_case_kind_and_data() {
    assert_eq!(
        serde_json::to_value(ResponsePayload::Pong(PongResult { seq: 7 }))
            .expect("serialize pong response"),
        json!({ "kind": "pong", "data": { "seq": 7 } })
    );
}

#[test]
fn notification_payload_uses_adjacent_kebab_case_kind_and_data() {
    assert_eq!(
        serde_json::to_value(NotificationPayload::Overload(OverloadNotification {
            queue: "egress".to_owned(),
            dropped_disposable: 3,
        }))
        .expect("serialize overload notification"),
        json!({
            "kind": "overload",
            "data": { "queue": "egress", "droppedDisposable": 3 }
        })
    );
}

#[test]
fn interaction_payload_uses_adjacent_kebab_case_kind_and_data() {
    assert_eq!(
        serde_json::to_value(InteractionPayload::Resolved(InteractionResolved {
            domain_generation_id: "generation-1".to_owned(),
            contract_hash: CONTRACT_HASH.to_owned(),
            session_id: "session-1".to_owned(),
            correlation_id: "interaction-1".to_owned(),
            reason: InteractionResolutionReason::Transferred,
        }))
        .expect("serialize resolved interaction"),
        json!({
            "kind": "resolved",
            "data": {
                "domainGenerationId": "generation-1",
                "contractHash": CONTRACT_HASH,
                "sessionId": "session-1",
                "correlationId": "interaction-1",
                "reason": "transferred"
            }
        })
    );
}

#[test]
fn negotiation_enables_mutual_stable_and_explicit_experimental_intersection() {
    let local = initialize_request(
        &["session", "snapshot", "prompt"],
        &["session"],
        &["stream-delta", "trace"],
    );
    let remote = initialize_request(
        &["snapshot", "session", "steer"],
        &["snapshot"],
        &["trace", "remote-debug"],
    );

    let result = negotiate_initialize(&local, &remote).expect("compatible initialization");

    assert_eq!(result.stable_capabilities, ["session", "snapshot"]);
    assert_eq!(result.experimental_capabilities, ["trace"]);
}

#[test]
fn negotiation_accepts_same_major_minor_versions_in_both_argument_orders() {
    let older = initialize_request(&["session", "snapshot"], &["session"], &["trace"]);
    let mut newer = older.clone();
    newer.protocol_version.minor = 2;

    let forward = negotiate_initialize(&older, &newer).expect("older local accepts newer remote");
    let reverse = negotiate_initialize(&newer, &older).expect("newer local accepts older remote");

    assert_eq!(
        forward.protocol_version,
        ProtocolVersion { major: 1, minor: 0 }
    );
    assert_eq!(reverse.protocol_version, forward.protocol_version);
}

#[test]
fn negotiation_rejects_major_hash_and_required_stable_incompatibilities() {
    struct Case {
        name: &'static str,
        local: InitializeRequest,
        remote: InitializeRequest,
        expected_issue: CompatibilityIssue,
    }

    let compatible = initialize_request(&["session", "snapshot"], &["session"], &[]);
    let mut major = compatible.clone();
    major.protocol_version.major = 2;
    let mut hash = compatible.clone();
    hash.contract_hash = "f".repeat(64);
    let local_requires_missing =
        initialize_request(&["session", "snapshot"], &["session", "lease"], &[]);
    let remote_requires_missing =
        initialize_request(&["session", "snapshot"], &["session", "steer"], &[]);

    let cases = [
        Case {
            name: "major version",
            local: compatible.clone(),
            remote: major,
            expected_issue: CompatibilityIssue::MajorVersion {
                local: 1,
                remote: 2,
            },
        },
        Case {
            name: "contract hash",
            local: compatible.clone(),
            remote: hash,
            expected_issue: CompatibilityIssue::ContractHash {
                local: CONTRACT_HASH.to_owned(),
                remote: "f".repeat(64),
            },
        },
        Case {
            name: "remote missing local requirement",
            local: local_requires_missing,
            remote: compatible.clone(),
            expected_issue: CompatibilityIssue::MissingStableCapability {
                endpoint: Endpoint::Remote,
                capability: "lease".to_owned(),
            },
        },
        Case {
            name: "local missing remote requirement",
            local: compatible.clone(),
            remote: remote_requires_missing,
            expected_issue: CompatibilityIssue::MissingStableCapability {
                endpoint: Endpoint::Local,
                capability: "steer".to_owned(),
            },
        },
    ];

    for case in cases {
        let error = negotiate_initialize(&case.local, &case.remote)
            .expect_err("incompatible initialization must fail closed");
        let ProtocolError::IncompatibleContract { issues } = error else {
            panic!(
                "{} must fail with an incompatible-contract error",
                case.name
            );
        };
        assert!(
            issues.contains(&case.expected_issue),
            "{} incompatibility returned {issues:?}",
            case.name
        );
    }
}

#[test]
fn generated_schema_hash_matches_rust_and_typescript_contract() {
    let schema = fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../generated/protocol.schema.json"
    ))
    .expect("read generated schema");
    let actual_hash = format!("{:x}", Sha256::digest(&schema));
    assert_eq!(actual_hash, CONTRACT_HASH);
    assert_eq!(CONTRACT_HASH.len(), 64);
    assert!(
        CONTRACT_HASH
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    );

    let declarations = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../generated/protocol.d.ts"
    ))
    .expect("read generated TypeScript declarations");
    let hash_declaration = format!("export const CONTRACT_HASH = \"{CONTRACT_HASH}\";");
    assert!(declarations.lines().any(|line| line == hash_declaration));
    assert!(!String::from_utf8(schema).unwrap().contains(CONTRACT_HASH));
}

#[test]
fn generated_schema_and_declarations_cover_protocol_roots_and_payloads() {
    let schema: Value = serde_json::from_slice(
        &fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../generated/protocol.schema.json"
        ))
        .expect("read generated schema"),
    )
    .expect("parse generated schema");
    let definitions = schema["$defs"]
        .as_object()
        .expect("protocol schema definitions");
    let names: BTreeSet<_> = definitions.keys().map(String::as_str).collect();
    for required in [
        "CommandEnvelope",
        "CommandPayload",
        "ResponseEnvelope",
        "ResponsePayload",
        "NotificationEnvelope",
        "NotificationPayload",
        "InteractionEnvelope",
        "InteractionPayload",
        "InitializeRequest",
        "InitializeResult",
        "CapabilityDescriptor",
        "OperationAvailability",
        "OperationMode",
        "UnavailableReason",
        "HostError",
    ] {
        assert!(
            names.contains(required),
            "missing schema definition {required}"
        );
    }
    for envelope in [
        "CommandEnvelope",
        "InteractionEnvelope",
        "NotificationEnvelope",
        "ResponseEnvelope",
    ] {
        assert_eq!(
            definitions[envelope]["type"],
            json!("object"),
            "{envelope} must carry its concrete object schema"
        );
    }
    assert!(
        names.iter().all(|name| {
            name.strip_prefix("Envelope").is_none_or(|suffix| {
                suffix.is_empty() || !suffix.chars().all(|character| character.is_ascii_digit())
            })
        }),
        "numbered envelope definitions leaked into schema: {names:?}"
    );
    assert_eq!(
        schema["required"],
        json!(["command", "interaction", "notification", "response"])
    );

    let declarations = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../generated/protocol.d.ts"
    ))
    .expect("read generated TypeScript declarations");
    for fragment in [
        "export type CommandEnvelope = {",
        "export type CommandPayload =",
        "export type ResponseEnvelope = {",
        "export type ResponsePayload =",
        "export type NotificationEnvelope = {",
        "export type NotificationPayload =",
        "export type InteractionEnvelope = {",
        "export type InteractionPayload =",
        "export type CapabilityDescriptor = {",
        "export type OperationAvailability = {",
        "export type HostError = {",
        "protocolVersion:",
        "domainGenerationId:",
        "correlationId?:",
        "kind: \"initialize\"",
        "data: InitializeRequest",
    ] {
        assert!(
            declarations.contains(fragment),
            "missing TypeScript declaration fragment {fragment:?}"
        );
    }
    for unstable in ["Envelope2", "Envelope3", "Envelope4"] {
        assert!(
            !declarations.contains(unstable),
            "unstable TypeScript definition {unstable} leaked"
        );
    }

    let tagged_schema = |definition: &str, kind: &str| {
        definitions[definition]["oneOf"]
            .as_array()
            .expect("tagged enum variants")
            .iter()
            .find(|variant| variant["properties"]["kind"]["const"] == json!(kind))
            .unwrap_or_else(|| panic!("missing {definition} variant {kind}"))
    };
    for (definition, kind) in [
        ("CommandPayload", "ping"),
        ("SessionCommand", "snapshot"),
        ("ProtocolError", "incompatible-contract"),
        ("ProtocolError", "host"),
        ("CompatibilityIssue", "major-version"),
        ("UnavailableReason", "not-negotiated"),
    ] {
        let variant = tagged_schema(definition, kind);
        assert_eq!(
            variant["additionalProperties"],
            json!(false),
            "{definition}/{kind} outer object must reject unknown fields"
        );
    }
    for (definition, kind) in [
        ("ProtocolError", "incompatible-contract"),
        ("ProtocolError", "host"),
        ("CompatibilityIssue", "major-version"),
        ("UnavailableReason", "not-negotiated"),
    ] {
        let data = &tagged_schema(definition, kind)["properties"]["data"];
        assert_eq!(
            data["additionalProperties"],
            json!(false),
            "{definition}/{kind} data object must reject unknown fields"
        );
    }
}

fn mutation_command(command: &str, request_id: &str) -> serde_json::Value {
    let data = match command {
        "acquire" => json!({
            "requestId": request_id,
            "sessionId": "session-1",
            "viewId": "view-1",
            "requestedMode": "controller"
        }),
        "transfer-controller" => json!({
            "requestId": request_id,
            "sessionId": "session-1",
            "leaseId": "lease-1",
            "targetViewId": "view-2"
        }),
        "submit-prompt" => json!({
            "requestId": request_id,
            "sessionId": "session-1",
            "leaseId": "lease-1",
            "turnId": "turn-1",
            "input": {}
        }),
        "cancel" => json!({
            "requestId": request_id,
            "sessionId": "session-1",
            "leaseId": "lease-1",
            "turnId": "turn-1"
        }),
        "steer" => json!({
            "requestId": request_id,
            "sessionId": "session-1",
            "leaseId": "lease-1",
            "turnId": "turn-1",
            "input": {}
        }),
        other => panic!("unknown mutation command {other}"),
    };
    json!({
        "kind": "session",
        "data": {
            "kind": command,
            "data": data
        }
    })
}

#[test]
fn mutation_commands_require_request_identity() {
    for command in [
        "acquire",
        "transfer-controller",
        "submit-prompt",
        "cancel",
        "steer",
    ] {
        let valid =
            serde_json::from_value::<CommandPayload>(mutation_command(command, "request-1"))
                .unwrap_or_else(|error| panic!("{command} with requestId is accepted: {error}"));
        let CommandPayload::Session(session_command) = valid else {
            panic!("expected session command for {command}")
        };
        let request_id = match session_command {
            SessionCommand::Acquire(request) => request.request_id,
            SessionCommand::TransferController(request) => request.request_id,
            SessionCommand::SubmitPrompt(request) => request.request_id,
            SessionCommand::Cancel(request) => request.request_id,
            SessionCommand::Steer(request) => request.request_id,
            SessionCommand::Snapshot(_) => panic!("snapshot is not a mutation command"),
        };
        assert_eq!(
            request_id, "request-1",
            "{command} carries request identity"
        );

        let mut without_id = mutation_command(command, "request-1");
        without_id["data"]["data"]
            .as_object_mut()
            .expect("mutation data object")
            .remove("requestId");
        let error = serde_json::from_value::<CommandPayload>(without_id)
            .expect_err("mutation command without requestId must be rejected");
        assert!(
            error.to_string().contains("requestId"),
            "{command} rejection must name the missing requestId: {error}"
        );
    }
}

#[test]
fn mutation_commands_reject_unknown_and_missing_discriminator() {
    for command in [
        "acquire",
        "transfer-controller",
        "submit-prompt",
        "cancel",
        "steer",
    ] {
        let mut unknown_field = mutation_command(command, "request-1");
        unknown_field["data"]["data"]
            .as_object_mut()
            .expect("mutation data object")
            .insert("unexpected".to_owned(), json!(true));
        assert!(
            serde_json::from_value::<CommandPayload>(unknown_field).is_err(),
            "mutation commands must reject unknown fields"
        );

        let mut missing_discriminator = mutation_command(command, "request-1");
        missing_discriminator["data"]
            .as_object_mut()
            .expect("session command object")
            .remove("kind");
        assert!(
            serde_json::from_value::<CommandPayload>(missing_discriminator).is_err(),
            "session command without a kind discriminator must be rejected"
        );
    }

    assert!(
        serde_json::from_value::<CommandPayload>(json!({ "data": { "kind": "submit-prompt" } }))
            .is_err(),
        "payload without a kind discriminator must be rejected"
    );
    assert!(
        serde_json::from_value::<CommandPayload>(json!({
            "kind": "session",
            "data": { "data": { "requestId": "request-1" } }
        }))
        .is_err(),
        "nested session command without a kind discriminator must be rejected"
    );
}

#[test]
fn capability_catalog_is_advertised_with_typed_availability() {
    let result = negotiate_initialize(
        &initialize_request(&["session"], &["session"], &["trace"]),
        &initialize_request(&["session"], &["session"], &["trace"]),
    )
    .expect("compatible initialization");

    let capability = CapabilityDescriptor {
        capability_id: "session.submit-prompt".to_owned(),
        schema_revision: 1,
        stability: CapabilityStability::Stable,
        mode: OperationMode::Mutate,
    };
    assert_eq!(
        serde_json::to_value(&capability).expect("serialize capability descriptor"),
        json!({
            "capabilityId": "session.submit-prompt",
            "schemaRevision": 1,
            "stability": "stable",
            "mode": "mutate"
        })
    );

    assert!(result.capabilities.contains(&capability));
    let availability = result
        .availability("session.submit-prompt")
        .expect("negotiated capability availability");
    assert_eq!(
        availability,
        OperationAvailability {
            capability_id: "session.submit-prompt".to_owned(),
            schema_revision: 1,
            available: true,
            mode: OperationMode::Mutate,
            reason: None,
        }
    );
    assert_eq!(
        serde_json::to_value(&availability).expect("serialize availability"),
        json!({
            "capabilityId": "session.submit-prompt",
            "schemaRevision": 1,
            "available": true,
            "mode": "mutate"
        })
    );

    let unavailable = result
        .availability("session.archive")
        .expect("unavailable capability still reports availability");
    assert!(!unavailable.available);
    assert_eq!(
        unavailable.reason,
        Some(UnavailableReason::NotNegotiated {
            message_key: "capability.not-negotiated".to_owned(),
        })
    );
}

#[test]
fn capability_availability_uses_typed_unavailable_reasons() {
    let cases = [
        (
            UnavailableReason::NotNegotiated {
                message_key: "capability.not-negotiated".to_owned(),
            },
            json!({
                "kind": "not-negotiated",
                "data": { "messageKey": "capability.not-negotiated" }
            }),
        ),
        (
            UnavailableReason::EnvironmentUnsupported {
                message_key: "capability.environment-unsupported".to_owned(),
            },
            json!({
                "kind": "environment-unsupported",
                "data": { "messageKey": "capability.environment-unsupported" }
            }),
        ),
        (
            UnavailableReason::TemporarilyUnavailable {
                message_key: "capability.busy".to_owned(),
            },
            json!({
                "kind": "temporarily-unavailable",
                "data": { "messageKey": "capability.busy" }
            }),
        ),
    ];
    for (reason, wire) in cases {
        assert_eq!(
            serde_json::to_value(&reason).expect("serialize unavailable reason"),
            wire
        );
        assert_eq!(
            serde_json::from_value::<UnavailableReason>(wire).expect("parse unavailable reason"),
            reason
        );
    }

    let mut unknown_reason = json!({
        "kind": "not-negotiated",
        "data": { "messageKey": "capability.not-negotiated" }
    });
    unknown_reason["unexpected"] = json!(true);
    assert!(
        serde_json::from_value::<UnavailableReason>(unknown_reason).is_err(),
        "unknown outer fields must be rejected"
    );
}

#[test]
fn host_error_is_a_typed_response_payload() {
    let host_error = HostError {
        code: "stale-lease".to_owned(),
        capability_id: Some("session.submit-prompt".to_owned()),
        retryable: false,
        indeterminate: false,
        detail: Some(json!({ "leaseId": "lease-1" })),
    };
    assert_eq!(
        serde_json::to_value(ResponsePayload::Error(ProtocolError::Host(
            host_error.clone()
        )))
        .expect("serialize host error response"),
        json!({
            "kind": "error",
            "data": {
                "kind": "host",
                "data": {
                    "code": "stale-lease",
                    "capabilityId": "session.submit-prompt",
                    "retryable": false,
                    "indeterminate": false,
                    "detail": { "leaseId": "lease-1" }
                }
            }
        })
    );

    let mut unknown_field = serde_json::to_value(&host_error).expect("serialize host error");
    unknown_field
        .as_object_mut()
        .expect("host error object")
        .insert("unexpected".to_owned(), json!(true));
    assert!(
        serde_json::from_value::<HostError>(unknown_field).is_err(),
        "host error must reject unknown fields"
    );
    assert!(
        serde_json::from_value::<HostError>(json!({ "code": "stale-lease" })).is_err(),
        "host error must reject missing typed fields"
    );
}

#[test]
fn operation_availability_round_trips_with_camel_case_wire_names() {
    let availability = OperationAvailability {
        capability_id: "session.archive".to_owned(),
        schema_revision: 2,
        available: false,
        mode: OperationMode::Read,
        reason: Some(UnavailableReason::NotNegotiated {
            message_key: "capability.not-negotiated".to_owned(),
        }),
    };
    let wire = serde_json::to_value(&availability).expect("serialize availability");
    assert_eq!(
        wire,
        json!({
            "capabilityId": "session.archive",
            "schemaRevision": 2,
            "available": false,
            "mode": "read",
            "reason": {
                "kind": "not-negotiated",
                "data": { "messageKey": "capability.not-negotiated" }
            }
        })
    );
    assert_eq!(
        serde_json::from_value::<OperationAvailability>(wire).expect("parse availability"),
        availability
    );

    let mut unknown_field = serde_json::to_value(&availability).expect("serialize availability");
    unknown_field
        .as_object_mut()
        .expect("availability object")
        .insert("unexpected".to_owned(), json!(true));
    assert!(
        serde_json::from_value::<OperationAvailability>(unknown_field).is_err(),
        "operation availability must reject unknown fields"
    );
}

#[test]
fn operation_modes_use_kebab_case_wire_values() {
    for (mode, expected) in [
        (OperationMode::Read, json!("read")),
        (OperationMode::Mutate, json!("mutate")),
        (OperationMode::Observe, json!("observe")),
    ] {
        assert_eq!(serde_json::to_value(mode).unwrap(), expected);
    }
    assert!(
        serde_json::from_value::<OperationMode>(json!("write")).is_err(),
        "unknown operation mode wire value must be rejected"
    );
}
