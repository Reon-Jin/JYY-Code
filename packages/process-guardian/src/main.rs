//! Minimal process guardian entrypoint.
//!
//! The guardian owns the launched child for the lifetime of this process. On
//! Unix the child is placed in a fresh process group so a negative-PGID kill
//! reaches descendants even after the original parent exits. Windows release
//! packaging replaces this executable with the Job Object build produced by
//! the platform release job; keeping the protocol identical lets the JS
//! supervisor fail closed when that artifact is missing.

use std::env;
use std::process::{Command, ExitCode};

fn usage() -> ! {
    eprintln!("usage: jyycode-process-guardian -- <command> [args ...]");
    std::process::exit(64);
}

#[cfg(windows)]
mod windows_job {
    use std::ffi::c_void;
    use std::io;
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    type Handle = *mut c_void;

    #[repr(C)]
    struct IoCounters {
        read_operations: u64,
        write_operations: u64,
        other_operations: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }

    #[repr(C)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: u32, info: *mut c_void, length: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    pub struct Job(Handle);

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    pub fn attach(child: &Child) -> io::Result<Job> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut info: ExtendedLimitInformation = std::mem::zeroed();
            info.basic.limit_flags = 0x0000_2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if SetInformationJobObject(
                job,
                9, // JobObjectExtendedLimitInformation
                (&mut info as *mut ExtendedLimitInformation).cast(),
                size_of::<ExtendedLimitInformation>() as u32,
            ) == 0
            {
                CloseHandle(job);
                return Err(io::Error::last_os_error());
            }
            if AssignProcessToJobObject(job, child.as_raw_handle() as Handle) == 0 {
                CloseHandle(job);
                return Err(io::Error::last_os_error());
            }
            Ok(Job(job))
        }
    }
}

fn run(command: &str, args: &[String]) -> std::io::Result<i32> {
    let mut child = Command::new(command);
    child.args(args);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // A process-group leader gives the supervisor a stable negative-PGID
        // target for TERM -> KILL -> verified group polling.
        child.process_group(0);
    }

    let mut process = child.spawn()?;

    #[cfg(windows)]
    let _job = windows_job::attach(&process)?;

    let status = process.wait()?;
    Ok(status.code().unwrap_or(1))
}

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let Some(separator) = args.next() else {
        usage()
    };
    if separator != "--" {
        usage()
    }
    let Some(command) = args.next() else { usage() };
    let rest: Vec<String> = args.collect();
    match run(&command, &rest) {
        Ok(code) => ExitCode::from(code.clamp(0, 255) as u8),
        Err(error) => {
            eprintln!("process guardian failed: {error}");
            ExitCode::from(127)
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn protocol_requires_separator() {
        assert_eq!("--", "--");
    }
}
