use std::io;
use std::path::PathBuf;
#[cfg(unix)]
use std::process::Command;
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

const TERMINATE_GRACE: Duration = Duration::from_secs(3);

pub struct ProcessPolicy {
    pub terminate_grace: Duration,
}

impl Default for ProcessPolicy {
    fn default() -> Self {
        Self {
            terminate_grace: TERMINATE_GRACE,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct SpawnSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub current_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessExit {
    code: i32,
}

impl ProcessExit {
    pub fn success(&self) -> bool {
        self.code == 0
    }
}

pub struct ManagedProcess {
    pid: u32,
    inner: ManagedProcessInner,
}

enum ManagedProcessInner {
    #[cfg(unix)]
    Unix(std::process::Child),
    #[cfg(windows)]
    Windows(WindowsProcess),
    #[cfg(not(any(windows, unix)))]
    Unsupported,
}

impl ManagedProcess {
    pub fn id(&self) -> u32 {
        self.pid
    }

    pub fn wait(&mut self) -> std::io::Result<ProcessExit> {
        match &mut self.inner {
            #[cfg(unix)]
            ManagedProcessInner::Unix(child) => {
                let status = child.wait()?;
                Ok(ProcessExit {
                    code: status.code().unwrap_or(-1),
                })
            }
            #[cfg(windows)]
            ManagedProcessInner::Windows(process) => {
                process.wait().map(|code| ProcessExit { code })
            }
            #[cfg(not(any(windows, unix)))]
            ManagedProcessInner::Unsupported => Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "unsupported platform",
            )),
        }
    }
}

pub enum ProcessBackend {
    #[cfg(windows)]
    Windows(ProcessJob),
    #[cfg(unix)]
    Unix(ProcessPolicy),
    #[cfg(not(any(windows, unix)))]
    Unsupported(ProcessPolicy),
}

impl ProcessBackend {
    pub fn create() -> io::Result<Self> {
        #[cfg(windows)]
        {
            Ok(Self::Windows(ProcessJob::create()?))
        }
        #[cfg(unix)]
        {
            Ok(Self::Unix(ProcessPolicy::default()))
        }
        #[cfg(not(any(windows, unix)))]
        {
            Ok(Self::Unsupported(ProcessPolicy::default()))
        }
    }

    pub fn spawn(&self, spec: SpawnSpec) -> io::Result<ManagedProcess> {
        #[cfg(windows)]
        {
            let Self::Windows(job) = self;
            Self::spawn_windows(job, spec)
        }

        #[cfg(unix)]
        {
            let Self::Unix(_) = self;
            Self::spawn_unix(spec)
        }

        #[cfg(not(any(windows, unix)))]
        {
            let _ = spec;
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "unsupported platform",
            ))
        }
    }

    pub fn terminate_tree(&self, process: &mut ManagedProcess, grace: Duration) -> io::Result<()> {
        #[cfg(windows)]
        {
            let _ = grace;
            let Self::Windows(job) = self;
            job.terminate()?;
            process.wait().map(|_| ())
        }

        #[cfg(unix)]
        {
            let Self::Unix(policy) = self;
            let pid = process.id() as i32;
            let deadline = Instant::now() + grace.min(policy.terminate_grace);
            unsafe {
                libc::kill(-pid, libc::SIGTERM);
            }

            while Instant::now() < deadline {
                let ManagedProcessInner::Unix(child) = &mut process.inner;
                if child.try_wait()?.is_some() {
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(10));
            }

            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
            process.wait().map(|_| ())
        }

        #[cfg(not(any(windows, unix)))]
        {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "unsupported platform",
            ))
        }
    }

    pub fn terminate_tree_graceful(&self, process: &mut ManagedProcess) -> io::Result<()> {
        self.terminate_tree(process, ProcessPolicy::default().terminate_grace)
    }

    #[cfg(unix)]
    fn spawn_unix(spec: SpawnSpec) -> io::Result<ManagedProcess> {
        use std::os::unix::process::CommandExt;

        let mut command = Command::new(&spec.program);
        command.args(&spec.args);
        if let Some(current_dir) = spec.current_dir {
            command.current_dir(current_dir);
        }
        command.process_group(0);

        let child = command.spawn()?;
        let pid = child.id();
        Ok(ManagedProcess {
            pid,
            inner: ManagedProcessInner::Unix(child),
        })
    }

    #[cfg(windows)]
    fn spawn_windows(job: &ProcessJob, spec: SpawnSpec) -> io::Result<ManagedProcess> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows_sys::Win32::System::Threading::{
            CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateProcessW, PROCESS_INFORMATION, ResumeThread,
            STARTUPINFOW, TerminateProcess,
        };

        let command_line = windows_command_line(&spec);
        let mut command_line_utf16: Vec<u16> = command_line.encode_utf16().chain(Some(0)).collect();
        let current_dir_utf16: Option<Vec<u16>> = spec
            .current_dir
            .as_ref()
            .map(|path| path.as_os_str().encode_wide().chain(Some(0)).collect());

        let startup_info = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            ..STARTUPINFOW::default()
        };

        let mut process_info = PROCESS_INFORMATION::default();
        let creation_flags = CREATE_NO_WINDOW | CREATE_SUSPENDED;
        let result = unsafe {
            CreateProcessW(
                std::ptr::null(),
                command_line_utf16.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                creation_flags,
                std::ptr::null(),
                current_dir_utf16
                    .as_ref()
                    .map(|value| value.as_ptr())
                    .unwrap_or(std::ptr::null()),
                &startup_info,
                &mut process_info,
            )
        };

        if result == 0 {
            return Err(io::Error::last_os_error());
        }

        let assigned = unsafe { AssignProcessToJobObject(job.handle, process_info.hProcess) };
        if assigned == 0 {
            unsafe {
                TerminateProcess(process_info.hProcess, 1);
                CloseHandle(process_info.hThread);
                CloseHandle(process_info.hProcess);
            }
            return Err(io::Error::last_os_error());
        }

        let resumed = unsafe { ResumeThread(process_info.hThread) };
        if resumed == u32::MAX {
            unsafe {
                TerminateProcess(process_info.hProcess, 1);
                CloseHandle(process_info.hThread);
                CloseHandle(process_info.hProcess);
            }
            return Err(io::Error::last_os_error());
        }

        unsafe {
            CloseHandle(process_info.hThread);
        }

        Ok(ManagedProcess {
            pid: process_info.dwProcessId,
            inner: ManagedProcessInner::Windows(WindowsProcess {
                handle: process_info.hProcess,
            }),
        })
    }
}

#[cfg(windows)]
pub struct WindowsProcess {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl WindowsProcess {
    fn wait(&self) -> io::Result<i32> {
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, INFINITE, WaitForSingleObject,
        };

        let wait_result = unsafe { WaitForSingleObject(self.handle, INFINITE) };
        if wait_result != 0 {
            return Err(io::Error::last_os_error());
        }

        let mut exit_code = 0u32;
        let result = unsafe { GetExitCodeProcess(self.handle, &mut exit_code) };
        if result == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(exit_code as i32)
    }
}

#[cfg(windows)]
impl Drop for WindowsProcess {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        if !self.handle.is_null() {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
}

#[cfg(windows)]
fn windows_command_line(spec: &SpawnSpec) -> String {
    let mut arguments = vec![spec.program.to_string_lossy().into_owned()];
    arguments.extend(spec.args.iter().cloned());
    arguments
        .into_iter()
        .map(|argument| quote_windows_argument(&argument))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(windows)]
fn quote_windows_argument(argument: &str) -> String {
    if argument.is_empty() {
        return "\"\"".to_owned();
    }
    if !argument
        .chars()
        .any(|character| character.is_whitespace() || character == '"')
    {
        return argument.to_owned();
    }

    let mut quoted = String::with_capacity(argument.len() + 2);
    quoted.push('"');
    let mut backslashes = 0usize;
    for character in argument.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                for _ in 0..(backslashes * 2 + 1) {
                    quoted.push('\\');
                }
                backslashes = 0;
                quoted.push('"');
            }
            other => {
                for _ in 0..backslashes {
                    quoted.push('\\');
                }
                backslashes = 0;
                quoted.push(other);
            }
        }
    }
    for _ in 0..(backslashes * 2) {
        quoted.push('\\');
    }
    quoted.push('"');
    quoted
}

#[cfg(windows)]
pub struct ProcessJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl ProcessJob {
    fn create() -> io::Result<Self> {
        use std::mem::{size_of, zeroed};
        use std::ptr::null;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JobObjectExtendedLimitInformation, SetInformationJobObject,
        };

        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        info.BasicLimitInformation.LimitFlags = 0x2000;
        let result = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if result == 0 {
            unsafe {
                CloseHandle(handle);
            }
            return Err(io::Error::last_os_error());
        }

        Ok(Self { handle })
    }

    fn terminate(&self) -> io::Result<()> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        if unsafe { TerminateJobObject(self.handle, 0) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        if !self.handle.is_null() {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
}
