use std::io;
use std::process::Child;
use std::time::Duration;

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

    pub fn terminate_tree(&self, child: &mut Child) -> io::Result<()> {
        #[cfg(windows)]
        {
            let Self::Windows(job) = self;
            let _ = child;
            job.terminate()
        }

        #[cfg(unix)]
        {
            match child.id() {
                Some(id) => {
                    if unsafe { libc::kill(-(id as i32), libc::SIGTERM) } == 0 {
                        return Ok(());
                    }
                    child.kill()
                }
                None => child.kill(),
            }
        }

        #[cfg(not(any(windows, unix)))]
        {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "unsupported platform",
            ))
        }
    }

    pub fn terminate_tree_graceful(&self, child: &mut Child) -> io::Result<()> {
        #[cfg(unix)]
        {
            let grace = match self {
                Self::Unix(policy) => policy.terminate_grace,
                _ => return self.terminate_tree(child),
            };
            if let Some(id) = child.id() {
                unsafe {
                    libc::kill(-(id as i32), libc::SIGTERM);
                }
                std::thread::sleep(grace);
                if child.try_wait()?.is_some() {
                    return Ok(());
                }
                unsafe {
                    libc::kill(-(id as i32), libc::SIGKILL);
                }
            }
        }

        self.terminate_tree(child)?;
        child.wait().map(|_| ())
    }
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
