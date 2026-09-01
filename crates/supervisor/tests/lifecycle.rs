use std::time::Duration;

use aio_dsh_supervisor::lifecycle::{
    LifecycleEffect, LifecycleEvent, LifecycleMachine, LifecycleState,
};

#[test]
fn demand_start_spawns_once_and_publishes_ready() {
    let mut lifecycle = LifecycleMachine::new(Duration::from_secs(30));

    assert_eq!(lifecycle.state(), LifecycleState::Stopped);
    assert_eq!(
        lifecycle.apply(LifecycleEvent::DemandStart),
        vec![LifecycleEffect::Spawn]
    );
    assert_eq!(lifecycle.state(), LifecycleState::Starting);
    assert!(lifecycle.domain_generation_id().is_some());

    let first_generation = lifecycle.domain_generation_id().unwrap().to_owned();
    assert!(lifecycle.apply(LifecycleEvent::DemandStart).is_empty());
    assert_eq!(
        lifecycle.domain_generation_id(),
        Some(first_generation.as_str())
    );

    assert_eq!(
        lifecycle.apply(LifecycleEvent::DshQuiescent {
            jobs: 0,
            interactions: 0
        }),
        vec![LifecycleEffect::PublishReady]
    );
    assert_eq!(lifecycle.state(), LifecycleState::Ready);
}

#[test]
fn prewarm_acquires_lifecycle_lease_and_releases_to_idle_reclaim() {
    let mut lifecycle = LifecycleMachine::new(Duration::from_secs(10));

    assert_eq!(
        lifecycle.apply(LifecycleEvent::PrewarmAcquired),
        vec![LifecycleEffect::Spawn]
    );
    assert_eq!(
        lifecycle.apply(LifecycleEvent::DshQuiescent {
            jobs: 0,
            interactions: 0
        }),
        vec![LifecycleEffect::PublishReady]
    );

    assert!(lifecycle.apply(LifecycleEvent::IdleGraceElapsed).is_empty());
    assert_eq!(
        lifecycle.apply(LifecycleEvent::ControllerReleased),
        vec![LifecycleEffect::Flush]
    );
    assert_eq!(
        lifecycle.apply(LifecycleEvent::IdleGraceElapsed),
        vec![LifecycleEffect::Dispose, LifecycleEffect::Stop]
    );
    assert_eq!(lifecycle.state(), LifecycleState::Stopped);
}

#[test]
fn prewarm_acquire_is_idempotent_for_one_lifecycle_lease() {
    let mut lifecycle = LifecycleMachine::new(Duration::from_secs(10));

    lifecycle.apply(LifecycleEvent::PrewarmAcquired);
    lifecycle.apply(LifecycleEvent::PrewarmAcquired);
    lifecycle.apply(LifecycleEvent::DshQuiescent {
        jobs: 0,
        interactions: 0,
    });

    assert_eq!(
        lifecycle.apply(LifecycleEvent::ControllerReleased),
        vec![LifecycleEffect::Flush]
    );
    assert_eq!(
        lifecycle.apply(LifecycleEvent::IdleGraceElapsed),
        vec![LifecycleEffect::Dispose, LifecycleEffect::Stop]
    );
}

#[test]
fn idle_reclaim_requires_authoritative_quiescence_and_grace() {
    let mut lifecycle = LifecycleMachine::new(Duration::from_millis(1));

    lifecycle.apply(LifecycleEvent::DemandStart);
    lifecycle.apply(LifecycleEvent::DshQuiescent {
        jobs: 1,
        interactions: 0,
    });

    assert_eq!(lifecycle.state(), LifecycleState::Busy);
    assert!(lifecycle.apply(LifecycleEvent::IdleGraceElapsed).is_empty());

    lifecycle.apply(LifecycleEvent::DshQuiescent {
        jobs: 0,
        interactions: 0,
    });
    assert_eq!(
        lifecycle.apply(LifecycleEvent::IdleGraceElapsed),
        vec![LifecycleEffect::Dispose, LifecycleEffect::Stop]
    );
}

#[test]
fn child_exit_with_active_turn_marks_interrupted_and_schedules_bounded_backoff() {
    let mut lifecycle = LifecycleMachine::new(Duration::from_secs(5));

    lifecycle.apply(LifecycleEvent::DemandStart);
    lifecycle.apply(LifecycleEvent::DshBusy);

    assert_eq!(
        lifecycle.apply(LifecycleEvent::ChildExited {
            active_turn: Some("turn-42".to_owned())
        }),
        vec![
            LifecycleEffect::MarkInterrupted {
                turn_id: "turn-42".to_owned()
            },
            LifecycleEffect::ScheduleRestart {
                after: Duration::from_millis(100)
            }
        ]
    );
    assert_eq!(lifecycle.state(), LifecycleState::Crashed);
    assert!(lifecycle.interactions().is_empty());

    assert_eq!(
        lifecycle.apply(LifecycleEvent::DemandStart),
        vec![LifecycleEffect::Spawn]
    );
    lifecycle.apply(LifecycleEvent::DshBusy);
    assert_eq!(
        lifecycle.apply(LifecycleEvent::ChildExited { active_turn: None }),
        vec![LifecycleEffect::ScheduleRestart {
            after: Duration::from_millis(200)
        }]
    );
}

#[test]
fn effects_are_buffered_and_can_be_taken() {
    let mut lifecycle = LifecycleMachine::new(Duration::from_secs(1));

    lifecycle.apply(LifecycleEvent::DemandStart);

    assert_eq!(lifecycle.effects(), &[LifecycleEffect::Spawn]);
    assert_eq!(lifecycle.take_effects(), vec![LifecycleEffect::Spawn]);
    assert!(lifecycle.effects().is_empty());
}

#[test]
fn shutdown_disposes_running_generation_and_becomes_unavailable() {
    let mut lifecycle = LifecycleMachine::new(Duration::from_secs(1));

    lifecycle.apply(LifecycleEvent::DemandStart);
    assert_eq!(
        lifecycle.apply(LifecycleEvent::Shutdown),
        vec![LifecycleEffect::Dispose, LifecycleEffect::Stop]
    );
    assert_eq!(lifecycle.state(), LifecycleState::Unavailable);
    assert!(lifecycle.apply(LifecycleEvent::DemandStart).is_empty());
}
