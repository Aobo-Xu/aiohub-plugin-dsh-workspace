use std::collections::BTreeSet;
use std::fs;

use aio_dsh_protocol::{
    CONTRACT_HASH, CommandPayload, CompatibilityIssue, Endpoint, Envelope, InitializeRequest,
    InteractionPayload, InteractionResolutionReason, InteractionResolved, NotificationPayload,
    OverloadNotification, PlatformFacts, PlatformKey, PongResult, ProtocolError, ProtocolVersion,
    ResponsePayload, RuntimeProvenance, SandboxLevel, SandboxStatus, negotiate_initialize,
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
                backend: "restricted-token".to_owned(),
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
fn negotiation_rejects_version_hash_and_required_stable_incompatibilities() {
    struct Case {
        name: &'static str,
        local: InitializeRequest,
        remote: InitializeRequest,
        expected_issue: CompatibilityIssue,
    }

    let compatible = initialize_request(&["session", "snapshot"], &["session"], &[]);
    let mut major = compatible.clone();
    major.protocol_version.major = 2;
    let mut minor = compatible.clone();
    minor.protocol_version.minor = 1;
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
            name: "minor version",
            local: compatible.clone(),
            remote: minor,
            expected_issue: CompatibilityIssue::MinorVersion {
                local: 0,
                remote: 1,
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
        let ProtocolError::IncompatibleContract { issues } = error;
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
    ] {
        assert!(
            names.contains(required),
            "missing schema definition {required}"
        );
    }
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
        "export type CommandEnvelope =",
        "export type CommandPayload =",
        "export type ResponseEnvelope =",
        "export type ResponsePayload =",
        "export type NotificationEnvelope =",
        "export type NotificationPayload =",
        "export type InteractionEnvelope =",
        "export type InteractionPayload =",
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
}
