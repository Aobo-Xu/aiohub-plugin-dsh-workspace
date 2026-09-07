//! Exactly-once ledger for supervisor mutations.
//!
//! Every mutation carries a caller-chosen `request_id`. The supervisor keeps a
//! bounded, in-memory record of recent requests in one of three states:
//! `pending` (received, downstream outcome unknown), `completed` (downstream
//! executed, result recorded) and `indeterminate` (outcome unknown after a
//! crash or lost response). A retransmission of the same request id returns
//! the recorded outcome instead of repeating the downstream transition.
//!
//! Cross-generation replay is never allowed: the ledger is keyed by the
//! generation that issued the mutation, and entries from older generations are
//! only consulted to reject replayed requests, never to serve recorded
//! results. Stale-generation and stale-lease requests are rejected before they
//! can touch downstream state, so their request ids are never recorded.

use std::collections::HashMap;

use aio_dsh_protocol::SessionCommand;

/// Outcome states tracked per request id. `pending` and `indeterminate` both
/// reject retransmission (the caller must not assume the mutation was not
/// executed); `completed` serves the recorded result.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MutationState {
    Pending,
    Completed,
    Indeterminate,
}

/// Recorded result of an already-executed mutation. Only completed mutations
/// carry a replayable result.
#[derive(Clone, Debug, PartialEq)]
pub enum MutationRecord {
    /// The mutation executed; the response frames recorded from the
    /// successful downstream run are replayed verbatim.
    Completed(Vec<String>),
    /// The mutation is in flight or its outcome is unknown; retransmission is
    /// rejected without a replayable result.
    Pending,
    Indeterminate,
}

/// Identity of one mutation attempt: the generation whose fencing applies plus
/// the caller-chosen request id.
#[derive(Clone, Debug, PartialEq)]
struct LedgerEntry {
    generation_id: String,
    record: MutationRecord,
}

/// Bounded in-memory ledger of mutation outcomes.
pub struct MutationLedger {
    records: HashMap<String, LedgerEntry>,
    capacity: usize,
    live_generation: Option<String>,
}

impl MutationLedger {
    pub fn new(capacity: usize) -> Self {
        Self {
            records: HashMap::new(),
            capacity: capacity.max(1),
            live_generation: None,
        }
    }

    /// Pins the ledger to a freshly minted generation. Entries of older
    /// generations are retained only for replay rejection.
    pub fn begin_generation(&mut self, generation_id: &str) {
        self.live_generation = Some(generation_id.to_owned());
    }

    /// Reserves a request id for a mutation about to be validated and sent
    /// downstream. Returns `Some(record)` when the request is a retransmission
    /// of an already-known request.
    ///
    /// Rejection and replay rules:
    /// - a completed request from the live generation replays its recorded
    ///   result,
    /// - a retransmission whose request id was recorded under a different
    ///   generation (or whose generation is no longer live) is only rejected,
    ///   never replayed: cross-generation results must not leak,
    /// - pending/indeterminate requests reject with no replayable result,
    /// - unknown ids are inserted as `Pending` so a concurrent duplicate is
    ///   recognized.
    pub fn begin(&mut self, generation_id: &str, request_id: &str) -> Option<MutationRecord> {
        if let Some(entry) = self.records.get(request_id) {
            let same_generation = entry.generation_id == generation_id;
            let live = self
                .live_generation
                .as_deref()
                .is_some_and(|live| live == generation_id);
            return match &entry.record {
                MutationRecord::Completed(frames) if same_generation && live => {
                    Some(MutationRecord::Completed(frames.clone()))
                }
                state => Some(match state {
                    MutationRecord::Completed(_) => MutationRecord::Pending,
                    other => other.clone(),
                }),
            };
        }
        self.insert_and_trim(
            request_id.to_owned(),
            LedgerEntry {
                generation_id: generation_id.to_owned(),
                record: MutationRecord::Pending,
            },
        );
        None
    }

    /// Records the successful downstream result frames for a request id.
    pub fn complete(&mut self, generation_id: &str, request_id: &str, frames: Vec<String>) {
        self.insert_and_trim(
            request_id.to_owned(),
            LedgerEntry {
                generation_id: generation_id.to_owned(),
                record: MutationRecord::Completed(frames),
            },
        );
    }

    /// Marks a request as lost (crash injection, dropped response). The id
    /// stays blocked for retransmission without a replayable result.
    pub fn interrupt(&mut self, generation_id: &str, request_id: &str) {
        self.insert_and_trim(
            request_id.to_owned(),
            LedgerEntry {
                generation_id: generation_id.to_owned(),
                record: MutationRecord::Indeterminate,
            },
        );
    }

    /// Removes the record when the mutation was rejected before reaching the
    /// downstream host. Rejected requests must not occupy ledger capacity nor
    /// block a later retry with a corrected request.
    pub fn discard(&mut self, generation_id: &str, request_id: &str) {
        if self
            .records
            .get(request_id)
            .is_some_and(|entry| entry.generation_id == generation_id)
        {
            self.records.remove(request_id);
        }
    }

    pub fn live_generation(&self) -> Option<&str> {
        self.live_generation.as_deref()
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    fn insert_and_trim(&mut self, request_id: String, entry: LedgerEntry) {
        if self.records.len() >= self.capacity && !self.records.contains_key(&request_id) {
            // Bounded memory: drop an arbitrary old entry. The live generation
            // keeps re-minting request identities, so evicting stale entries
            // preserves the exactly-once window for recent requests.
            let oldest = self
                .records
                .keys()
                .next()
                .cloned()
                .expect("checked non-empty above");
            self.records.remove(&oldest);
        }
        self.records.insert(request_id, entry);
    }
}

/// Request identity carried by every mutation command.
pub fn request_id_of(command: &SessionCommand) -> Option<&str> {
    match command {
        SessionCommand::Acquire(request) => Some(&request.request_id),
        SessionCommand::TransferController(request) => Some(&request.request_id),
        SessionCommand::SubmitPrompt(request) => Some(&request.request_id),
        SessionCommand::Cancel(request) => Some(&request.request_id),
        SessionCommand::Steer(request) => Some(&request.request_id),
        SessionCommand::Snapshot(_) => None,
    }
}

/// Stable capability that must be negotiated before the command is allowed to
/// run. Mirrors `capability_catalog()` in the protocol crate: every session
/// command, including snapshots, hangs off the `session` capability.
pub fn capability_for_command(command: &SessionCommand) -> &'static str {
    match command {
        SessionCommand::Acquire(_)
        | SessionCommand::TransferController(_)
        | SessionCommand::SubmitPrompt(_)
        | SessionCommand::Cancel(_)
        | SessionCommand::Steer(_)
        | SessionCommand::Snapshot(_) => "session",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_request_id_replays_recorded_result_within_the_live_generation() {
        let mut ledger = MutationLedger::new(8);
        ledger.begin_generation("generation-1");

        assert_eq!(ledger.begin("generation-1", "request-1"), None);
        ledger.complete("generation-1", "request-1", vec!["frame".to_owned()]);

        assert_eq!(
            ledger.begin("generation-1", "request-1"),
            Some(MutationRecord::Completed(vec!["frame".to_owned()]))
        );
    }

    #[test]
    fn cross_generation_retransmission_is_rejected_without_replay() {
        let mut ledger = MutationLedger::new(8);
        ledger.begin_generation("generation-1");
        assert_eq!(ledger.begin("generation-1", "request-1"), None);
        ledger.complete("generation-1", "request-1", vec!["frame".to_owned()]);
        ledger.begin_generation("generation-2");

        assert_eq!(
            ledger.begin("generation-2", "request-1"),
            Some(MutationRecord::Pending),
            "cross-generation requests are only rejected, never replayed"
        );
    }

    #[test]
    fn pending_and_indeterminate_requests_block_retransmission() {
        let mut ledger = MutationLedger::new(8);
        ledger.begin_generation("generation-1");
        assert_eq!(ledger.begin("generation-1", "request-1"), None);

        assert_eq!(
            ledger.begin("generation-1", "request-1"),
            Some(MutationRecord::Pending)
        );

        ledger.interrupt("generation-1", "request-1");
        assert_eq!(
            ledger.begin("generation-1", "request-1"),
            Some(MutationRecord::Indeterminate)
        );
    }

    #[test]
    fn discarded_rejections_leave_no_record() {
        let mut ledger = MutationLedger::new(8);
        ledger.begin_generation("generation-1");
        assert_eq!(ledger.begin("generation-1", "request-1"), None);
        ledger.discard("generation-1", "request-1");

        assert_eq!(ledger.begin("generation-1", "request-1"), None);
    }

    #[test]
    fn ledger_stays_bounded() {
        let mut ledger = MutationLedger::new(4);
        ledger.begin_generation("generation-1");
        for index in 0..16 {
            assert_eq!(
                ledger.begin("generation-1", &format!("request-{index}")),
                None
            );
        }

        assert!(ledger.len() <= 4);
    }
}
