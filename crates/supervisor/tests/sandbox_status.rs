use aio_dsh_protocol::{SandboxBackend, SandboxLevel};
use aio_dsh_supervisor::{PlatformTarget, SandboxStatus};

#[test]
fn linux_reports_bwrap_before_landlock() {
    let status = SandboxStatus::for_platform(PlatformTarget::LinuxX64);

    assert_eq!(status.level, SandboxLevel::Partial);
    assert_eq!(status.backend, SandboxBackend::Bwrap);
    assert_eq!(status.reason, Some("bwrap preferred; landlock fallback"));
}

#[test]
fn linux_arm64_reports_the_same_sandbox_preference() {
    let status = SandboxStatus::for_platform(PlatformTarget::LinuxArm64);

    assert_eq!(status.level, SandboxLevel::Partial);
    assert_eq!(status.backend, SandboxBackend::Bwrap);
    assert_eq!(status.reason, Some("bwrap preferred; landlock fallback"));
}

#[test]
fn macos_reports_seatbelt_as_a_full_sandbox() {
    let status = SandboxStatus::for_platform(PlatformTarget::DarwinArm64);

    assert_eq!(status.level, SandboxLevel::Full);
    assert_eq!(status.backend, SandboxBackend::Seatbelt);
    assert_eq!(status.reason, None);
}

#[test]
fn windows_reports_restricted_token_plus_acl() {
    let status = SandboxStatus::for_platform(PlatformTarget::Win32X64);

    assert_eq!(status.level, SandboxLevel::Partial);
    assert_eq!(status.backend, SandboxBackend::RestrictedToken);
    assert_eq!(status.reason, Some("restricted token plus ACL"));
}
