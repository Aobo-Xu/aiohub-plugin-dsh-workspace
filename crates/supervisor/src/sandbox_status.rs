use aio_dsh_protocol::{SandboxBackend, SandboxLevel};

use crate::runtime::PlatformTarget;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxStatus {
    pub level: SandboxLevel,
    pub backend: SandboxBackend,
    pub reason: Option<&'static str>,
}

impl SandboxStatus {
    pub fn for_platform(platform: PlatformTarget) -> Self {
        match platform {
            PlatformTarget::LinuxX64 | PlatformTarget::LinuxArm64 => Self {
                level: SandboxLevel::Partial,
                backend: SandboxBackend::Bwrap,
                reason: Some("bwrap preferred; landlock fallback"),
            },
            PlatformTarget::DarwinArm64 => Self {
                level: SandboxLevel::Full,
                backend: SandboxBackend::Seatbelt,
                reason: None,
            },
            PlatformTarget::Win32X64 => Self {
                level: SandboxLevel::Partial,
                backend: SandboxBackend::RestrictedToken,
                reason: Some("restricted token plus ACL"),
            },
        }
    }
}
