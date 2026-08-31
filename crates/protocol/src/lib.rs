mod messages;

pub use messages::*;

pub const CONTRACT_HASH: &str = include_str!("../../../generated/protocol.sha256");
