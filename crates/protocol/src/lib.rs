mod messages;

pub use messages::*;

#[cfg(protocol_hash_present)]
pub const CONTRACT_HASH: &str = include_str!("../../../generated/protocol.sha256");

#[cfg(not(protocol_hash_present))]
pub const CONTRACT_HASH: &str = include_str!(concat!(env!("OUT_DIR"), "/protocol.sha256"));
