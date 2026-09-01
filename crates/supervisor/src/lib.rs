//! Supervisor composition root for the DSH sidecar.
//!
//! The public types in this crate are defined and implemented by Task 6.
//! Loadable fail-closed stubs for later tasks are registered here.

pub mod credentials;
pub mod home;
pub mod lease;
pub mod lifecycle;
pub mod process;
pub mod recovery;
pub mod runtime;
pub mod sandbox_status;
pub mod supervisor;

pub use credentials::Credentials;
pub use home::{DshHomeLayout, HomeMode};
pub use lease::Lease;
pub use lifecycle::Lifecycle;
pub use process::{ManagedProcess, ProcessBackend, ProcessExit, ProcessPolicy, SpawnSpec};
pub use recovery::Recovery;
pub use runtime::{PlatformTarget, RuntimeValidator};
pub use sandbox_status::SandboxStatus;
pub use supervisor::{
    ClientValidation, RedactionPolicy, SecretValue, StartupFlags, Supervisor, SupervisorConfig,
    SupervisorOwner,
};
