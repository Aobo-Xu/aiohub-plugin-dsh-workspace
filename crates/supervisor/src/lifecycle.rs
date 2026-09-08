use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::{lease::Lease, recovery::Recovery};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleState {
    Stopped,
    Starting,
    Ready,
    Busy,
    Stopping,
    Crashed,
    Unavailable,
    Upgrading,
    Recovering,
    Maintenance,
    Incompatible,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LifecycleEvent {
    DemandStart,
    StartFailed,
    PrewarmAcquired,
    ControllerReleased,
    DshBusy,
    DshQuiescent { jobs: usize, interactions: usize },
    ChildExited { active_turn: Option<String> },
    HandleStarted { handle_id: String },
    HandleFinished { handle_id: String },
    EnterMaintenance,
    BeginUpgrade,
    BeginRecovery,
    MarkIncompatible,
    IdleGraceElapsed,
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LifecycleEffect {
    Spawn,
    PublishReady,
    Flush,
    Dispose,
    Stop,
    MarkInterrupted { turn_id: String },
    ScheduleRestart { after: Duration },
}

pub struct Lifecycle;

#[derive(Debug, Clone)]
pub struct LifecycleMachine {
    state: LifecycleState,
    idle_grace: Duration,
    lease: Lease,
    effects: Vec<LifecycleEffect>,
    generation: u64,
    process_generation_prefix: String,
    domain_generation_id: Option<String>,
    interactions: Vec<String>,
    active_handles: Vec<String>,
    recovery: Recovery,
    quiescent: bool,
}

impl LifecycleMachine {
    pub fn new(idle_grace: Duration) -> Self {
        let marker = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        Self {
            state: LifecycleState::Stopped,
            idle_grace,
            lease: Lease::default(),
            effects: Vec::new(),
            generation: 0,
            process_generation_prefix: format!("{}-{marker}", std::process::id()),
            domain_generation_id: None,
            interactions: Vec::new(),
            active_handles: Vec::new(),
            recovery: Recovery::new(),
            quiescent: false,
        }
    }

    pub fn apply(&mut self, event: LifecycleEvent) -> Vec<LifecycleEffect> {
        let effects = match event {
            LifecycleEvent::DemandStart => self.start(false),
            LifecycleEvent::StartFailed => self.start_failed(),
            LifecycleEvent::PrewarmAcquired => self.start(true),
            LifecycleEvent::ControllerReleased => self.release_controller(),
            LifecycleEvent::DshBusy => self.mark_busy(),
            LifecycleEvent::DshQuiescent { jobs, interactions } => {
                self.mark_quiescent(jobs, interactions)
            }
            LifecycleEvent::ChildExited { active_turn } => self.child_exited(active_turn),
            LifecycleEvent::HandleStarted { handle_id } => {
                self.track_handle(handle_id);
                Vec::new()
            }
            LifecycleEvent::HandleFinished { handle_id } => {
                self.finish_handle(&handle_id);
                Vec::new()
            }
            LifecycleEvent::EnterMaintenance => self.enter_maintenance(),
            LifecycleEvent::BeginUpgrade => self.begin_upgrade(),
            LifecycleEvent::BeginRecovery => self.begin_recovery(),
            LifecycleEvent::MarkIncompatible => self.mark_incompatible(),
            LifecycleEvent::IdleGraceElapsed => self.idle_grace_elapsed(),
            LifecycleEvent::Shutdown => self.shutdown(),
        };
        self.effects.extend(effects.iter().cloned());
        effects
    }

    pub fn effects(&self) -> &[LifecycleEffect] {
        &self.effects
    }

    pub fn take_effects(&mut self) -> Vec<LifecycleEffect> {
        std::mem::take(&mut self.effects)
    }

    pub fn state(&self) -> LifecycleState {
        self.state
    }

    pub fn domain_generation_id(&self) -> Option<&str> {
        self.domain_generation_id.as_deref()
    }

    pub fn interactions(&self) -> &[String] {
        &self.interactions
    }

    pub fn idle_grace(&self) -> Duration {
        self.idle_grace
    }

    pub fn mutations_allowed(&self) -> bool {
        matches!(self.state, LifecycleState::Ready | LifecycleState::Busy)
    }

    pub fn active_handles(&self) -> &[String] {
        &self.active_handles
    }

    fn start(&mut self, prewarm: bool) -> Vec<LifecycleEffect> {
        if prewarm {
            self.lease.acquire();
        }

        match self.state {
            LifecycleState::Stopped | LifecycleState::Crashed => {
                self.state = LifecycleState::Starting;
                self.quiescent = false;
                self.generation = self.generation.saturating_add(1);
                self.domain_generation_id = Some(format!(
                    "dsh-generation-{}-{}",
                    self.process_generation_prefix, self.generation
                ));
                vec![LifecycleEffect::Spawn]
            }
            LifecycleState::Unavailable
            | LifecycleState::Upgrading
            | LifecycleState::Recovering
            | LifecycleState::Maintenance
            | LifecycleState::Incompatible
            | LifecycleState::Starting
            | LifecycleState::Ready
            | LifecycleState::Busy
            | LifecycleState::Stopping => Vec::new(),
        }
    }

    fn release_controller(&mut self) -> Vec<LifecycleEffect> {
        self.lease.release();
        if matches!(self.state, LifecycleState::Ready | LifecycleState::Busy) {
            vec![LifecycleEffect::Flush]
        } else {
            Vec::new()
        }
    }

    fn start_failed(&mut self) -> Vec<LifecycleEffect> {
        if matches!(self.state, LifecycleState::Starting) {
            self.state = LifecycleState::Stopped;
            self.domain_generation_id = None;
            self.quiescent = false;
            self.interactions.clear();
        }
        Vec::new()
    }

    fn mark_busy(&mut self) -> Vec<LifecycleEffect> {
        if matches!(self.state, LifecycleState::Starting | LifecycleState::Ready) {
            self.state = LifecycleState::Busy;
            self.quiescent = false;
        }
        Vec::new()
    }

    fn mark_quiescent(&mut self, jobs: usize, interactions: usize) -> Vec<LifecycleEffect> {
        self.quiescent = jobs == 0 && interactions == 0;
        if !self.quiescent {
            self.state = LifecycleState::Busy;
            return Vec::new();
        }

        match self.state {
            LifecycleState::Starting | LifecycleState::Busy => {
                self.state = LifecycleState::Ready;
                self.recovery.reset();
                vec![LifecycleEffect::PublishReady]
            }
            LifecycleState::Ready => Vec::new(),
            LifecycleState::Recovering => {
                self.state = LifecycleState::Ready;
                self.recovery.reset();
                vec![LifecycleEffect::PublishReady]
            }
            LifecycleState::Stopped
            | LifecycleState::Stopping
            | LifecycleState::Crashed
            | LifecycleState::Unavailable
            | LifecycleState::Upgrading
            | LifecycleState::Maintenance
            | LifecycleState::Incompatible => Vec::new(),
        }
    }

    fn child_exited(&mut self, active_turn: Option<String>) -> Vec<LifecycleEffect> {
        if matches!(
            self.state,
            LifecycleState::Stopped | LifecycleState::Unavailable | LifecycleState::Incompatible
        ) {
            return Vec::new();
        }

        self.state = LifecycleState::Crashed;
        self.quiescent = false;
        self.interactions.clear();

        if let Some(turn_id) = active_turn
            && !self.active_handles.contains(&turn_id)
        {
            self.active_handles.push(turn_id);
        }
        let mut effects = self
            .active_handles
            .drain(..)
            .map(|turn_id| LifecycleEffect::MarkInterrupted { turn_id })
            .collect::<Vec<_>>();
        effects.push(LifecycleEffect::ScheduleRestart {
            after: self.recovery.next_restart_delay(),
        });
        effects
    }

    fn track_handle(&mut self, handle_id: String) {
        if self.mutations_allowed() && !self.active_handles.contains(&handle_id) {
            self.active_handles.push(handle_id);
        }
    }

    fn finish_handle(&mut self, handle_id: &str) {
        self.active_handles.retain(|active| active != handle_id);
    }

    fn enter_maintenance(&mut self) -> Vec<LifecycleEffect> {
        if matches!(self.state, LifecycleState::Ready | LifecycleState::Busy) {
            self.state = LifecycleState::Maintenance;
        }
        Vec::new()
    }

    fn begin_upgrade(&mut self) -> Vec<LifecycleEffect> {
        if matches!(
            self.state,
            LifecycleState::Ready | LifecycleState::Maintenance
        ) {
            self.state = LifecycleState::Upgrading;
        }
        Vec::new()
    }

    fn begin_recovery(&mut self) -> Vec<LifecycleEffect> {
        if matches!(
            self.state,
            LifecycleState::Crashed | LifecycleState::Maintenance | LifecycleState::Upgrading
        ) {
            self.state = LifecycleState::Recovering;
        }
        Vec::new()
    }

    fn mark_incompatible(&mut self) -> Vec<LifecycleEffect> {
        if self.state != LifecycleState::Unavailable {
            self.state = LifecycleState::Incompatible;
        }
        Vec::new()
    }

    fn idle_grace_elapsed(&mut self) -> Vec<LifecycleEffect> {
        if self.lease.is_held() || !self.quiescent {
            return Vec::new();
        }

        if matches!(self.state, LifecycleState::Ready) {
            self.state = LifecycleState::Stopped;
            self.domain_generation_id = None;
            return vec![LifecycleEffect::Dispose, LifecycleEffect::Stop];
        }

        Vec::new()
    }

    fn shutdown(&mut self) -> Vec<LifecycleEffect> {
        if self.state == LifecycleState::Unavailable {
            return Vec::new();
        }

        let was_running = !matches!(self.state, LifecycleState::Stopped);
        self.state = LifecycleState::Unavailable;
        self.domain_generation_id = None;
        self.interactions.clear();
        self.active_handles.clear();
        self.quiescent = false;
        self.lease = Lease::default();

        if was_running {
            vec![LifecycleEffect::Dispose, LifecycleEffect::Stop]
        } else {
            vec![LifecycleEffect::Stop]
        }
    }
}
