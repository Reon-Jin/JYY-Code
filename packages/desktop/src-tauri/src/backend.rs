use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use tauri::AppHandle;
use tauri_plugin_shell::{
    ShellExt,
    process::{CommandChild, CommandEvent},
};
use tokio::sync::oneshot;

const BACKEND_USERNAME: &str = "jyycode";
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const BOOTSTRAP_POLL_INTERVAL: Duration = Duration::from_millis(25);
const STDERR_LINE_LIMIT: usize = 200;
const STDOUT_BUFFER_LIMIT: usize = 64 * 1024;

#[derive(Clone, Debug, serde::Deserialize)]
struct ReadyLine {
    #[serde(rename = "type")]
    kind: String,
    hostname: String,
    port: u16,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBootstrap {
    pub base_url: String,
    pub username: String,
    pub password: String,
}

#[derive(Clone, Debug)]
enum BackendPhase {
    Starting,
    Ready(DesktopBootstrap),
    Failed(String),
    Stopped,
}

struct BackendInner {
    phase: Mutex<BackendPhase>,
    child: Mutex<Option<CommandChild>>,
    stderr: Mutex<VecDeque<String>>,
    auto_restart_used: AtomicBool,
    stopping: AtomicBool,
    generation: AtomicU64,
    /// Win32 job object configured with KILL_ON_JOB_CLOSE that owns the sidecar.
    /// Stored as usize because raw handles are not Send.
    #[cfg(windows)]
    job: Mutex<Option<usize>>,
}

#[derive(Clone)]
pub struct BackendSupervisor {
    inner: Arc<BackendInner>,
}

struct StartupWait {
    generation: u64,
    receiver: oneshot::Receiver<Result<(), String>>,
}

impl Default for BackendSupervisor {
    fn default() -> Self {
        Self {
            inner: Arc::new(BackendInner {
                phase: Mutex::new(BackendPhase::Stopped),
                child: Mutex::new(None),
                stderr: Mutex::new(VecDeque::with_capacity(STDERR_LINE_LIMIT)),
                auto_restart_used: AtomicBool::new(false),
                stopping: AtomicBool::new(false),
                generation: AtomicU64::new(0),
                #[cfg(windows)]
                job: Mutex::new(None),
            }),
        }
    }
}

impl BackendSupervisor {
    fn phase(&self) -> Result<MutexGuard<'_, BackendPhase>, String> {
        self.inner
            .phase
            .lock()
            .map_err(|_| "backend state is unavailable".into())
    }

    fn child(&self) -> Result<MutexGuard<'_, Option<CommandChild>>, String> {
        self.inner
            .child
            .lock()
            .map_err(|_| "backend process state is unavailable".into())
    }

    fn kill_owned_child(&self) -> Result<Option<u32>, String> {
        let mut child = self.child()?;
        let Some(child) = child.take() else {
            return Ok(None);
        };
        let pid = child.pid();
        child
            .kill()
            .map_err(|error| format!("failed to stop JYYCode backend: {error}"))?;
        Ok(Some(pid))
    }

    /// Returns a job object configured with KILL_ON_JOB_CLOSE so the OS reaps
    /// the sidecar when this process exits for any reason. A force-killed
    /// desktop process runs no Rust cleanup (the Windows smoke test kills the
    /// desktop this way), so only the kernel can guarantee the sidecar dies
    /// with us.
    #[cfg(windows)]
    fn kill_on_close_job(&self) -> Option<windows_sys::Win32::Foundation::HANDLE> {
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };

        let mut slot = self.inner.job.lock().ok()?;
        if let Some(handle) = *slot {
            return Some(handle as windows_sys::Win32::Foundation::HANDLE);
        }
        let job = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
        if job.is_null() {
            return None;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
            return None;
        }
        *slot = Some(job as usize);
        Some(job)
    }

    #[cfg(windows)]
    fn assign_child_kill_on_close(&self, pid: u32) {
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };

        let Some(job) = self.kill_on_close_job() else {
            return;
        };
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if process.is_null() {
            return;
        }
        unsafe {
            AssignProcessToJobObject(job, process);
            windows_sys::Win32::Foundation::CloseHandle(process);
        }
    }

    fn is_current_generation(&self, generation: u64) -> bool {
        self.inner.generation.load(Ordering::SeqCst) == generation
    }

    fn set_phase_for_generation(&self, generation: u64, value: BackendPhase) -> bool {
        let Ok(mut phase) = self.phase() else {
            return false;
        };
        if !self.is_current_generation(generation) {
            return false;
        }
        *phase = value;
        true
    }

    fn clear_child_for_generation(&self, generation: u64) {
        if let Ok(mut child) = self.child()
            && self.is_current_generation(generation)
        {
            child.take();
        }
    }

    fn fail_and_kill_generation(&self, generation: u64, message: &str) {
        if !self.set_phase_for_generation(generation, BackendPhase::Failed(message.to_owned())) {
            return;
        }
        if self
            .inner
            .generation
            .compare_exchange(
                generation,
                generation.wrapping_add(1),
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
        {
            let _ = self.kill_owned_child();
        }
    }

    pub async fn start(&self, app: AppHandle) -> Result<(), String> {
        let Some(wait) = self.launch(app)? else {
            return Ok(());
        };

        self.wait_for_ready(wait).await
    }

    fn launch(&self, app: AppHandle) -> Result<Option<StartupWait>, String> {
        self.inner.stopping.store(false, Ordering::SeqCst);

        let password = random_password();
        let bootstrap = DesktopBootstrap {
            base_url: String::new(),
            username: BACKEND_USERNAME.into(),
            password: password.clone(),
        };

        let events = {
            let mut child_slot = self.child()?;
            if child_slot.is_some() {
                return Ok(None);
            }

            let generation = self
                .inner
                .generation
                .fetch_add(1, Ordering::SeqCst)
                .wrapping_add(1);
            *self.phase()? = BackendPhase::Starting;
            let command = match app.shell().sidecar("jyycode-sidecar") {
                Ok(command) => command,
                Err(error) => {
                    let message = format!("failed to configure JYYCode backend: {error}");
                    self.set_phase_for_generation(
                        generation,
                        BackendPhase::Failed(message.clone()),
                    );
                    return Err(message);
                }
            }
            .args(["serve", "--json", "--hostname", "127.0.0.1", "--port", "0"])
            .env("JYYCODE_SERVER_USERNAME", BACKEND_USERNAME)
            .env("JYYCODE_SERVER_PASSWORD", &password)
            .env("JYYCODE_EXPERIMENTAL_EVENT_SYSTEM", "1");

            let (events, child) = match command.spawn() {
                Ok(process) => process,
                Err(error) => {
                    let message = format!("failed to start JYYCode backend: {error}");
                    self.set_phase_for_generation(
                        generation,
                        BackendPhase::Failed(message.clone()),
                    );
                    return Err(message);
                }
            };
            // A force-kill of this process (crash, Task Manager, the Windows
            // smoke test's Stop-Process) runs no cleanup code, so tie the
            // sidecar's lifetime to ours with a kill-on-close job object.
            #[cfg(windows)]
            self.assign_child_kill_on_close(child.pid());
            *child_slot = Some(child);
            (generation, events)
        };

        let (generation, mut events) = events;

        let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();
        let supervisor = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut ready_tx = Some(ready_tx);
            let mut stdout_buffer = String::new();
            while let Some(event) = events.recv().await {
                if !supervisor.is_current_generation(generation) {
                    return;
                }
                match event {
                    CommandEvent::Stdout(bytes) => {
                        if let Some(ready) = push_ready_chunk(&mut stdout_buffer, &bytes) {
                            let mut value = bootstrap.clone();
                            value.base_url = format!("http://{}:{}", ready.hostname, ready.port);
                            if supervisor
                                .set_phase_for_generation(generation, BackendPhase::Ready(value))
                                && let Some(sender) = ready_tx.take()
                            {
                                let _ = sender.send(Ok(()));
                            }
                        }
                    }
                    CommandEvent::Stderr(bytes) => {
                        supervisor.remember_stderr(&String::from_utf8_lossy(&bytes), &password);
                    }
                    CommandEvent::Error(_) => {
                        supervisor
                            .fail_and_kill_generation(generation, "JYYCode backend stream failed");
                        if let Some(sender) = ready_tx.take() {
                            let _ = sender
                                .send(Err("JYYCode backend failed before it was ready".into()));
                        }
                        return;
                    }
                    CommandEvent::Terminated(_) => {
                        let was_ready = supervisor
                            .phase()
                            .map(|phase| matches!(*phase, BackendPhase::Ready(_)))
                            .unwrap_or(false);
                        supervisor.clear_child_for_generation(generation);

                        if !supervisor.is_current_generation(generation) {
                            return;
                        }

                        if supervisor.inner.stopping.load(Ordering::SeqCst) {
                            supervisor.set_phase_for_generation(generation, BackendPhase::Stopped);
                        } else if was_ready
                            && !supervisor
                                .inner
                                .auto_restart_used
                                .swap(true, Ordering::SeqCst)
                        {
                            if !supervisor
                                .set_phase_for_generation(generation, BackendPhase::Starting)
                            {
                                return;
                            }
                            let restart_supervisor = supervisor.clone();
                            let restart_app = app.clone();
                            match restart_supervisor.launch(restart_app) {
                                Ok(Some(restart_wait)) => {
                                    tauri::async_runtime::spawn(async move {
                                        let _ =
                                            restart_supervisor.wait_for_ready(restart_wait).await;
                                    });
                                }
                                Ok(None) => {}
                                Err(_) => {}
                            }
                        } else {
                            supervisor.set_phase_for_generation(
                                generation,
                                BackendPhase::Failed("JYYCode backend exited unexpectedly".into()),
                            );
                        }

                        if let Some(sender) = ready_tx.take() {
                            let _ = sender
                                .send(Err("JYYCode backend exited before it was ready".into()));
                        }
                        return;
                    }
                    _ => {}
                }
            }
        });

        Ok(Some(StartupWait {
            generation,
            receiver: ready_rx,
        }))
    }

    async fn wait_for_ready(&self, wait: StartupWait) -> Result<(), String> {
        match tokio::time::timeout(READY_TIMEOUT, wait.receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                if !self.is_current_generation(wait.generation) {
                    return Err("JYYCode backend startup was superseded".into());
                }
                self.fail_and_kill_generation(
                    wait.generation,
                    "JYYCode backend readiness channel closed",
                );
                Err("JYYCode backend readiness channel closed".into())
            }
            Err(_) => {
                if !self.is_current_generation(wait.generation) {
                    return Err("JYYCode backend startup was superseded".into());
                }
                self.fail_and_kill_generation(
                    wait.generation,
                    "JYYCode backend did not become ready within 20 seconds",
                );
                Err("JYYCode backend did not become ready within 20 seconds".into())
            }
        }
    }

    fn remember_stderr(&self, line: &str, password: &str) {
        if let Ok(mut stderr) = self.inner.stderr.lock() {
            if stderr.len() == STDERR_LINE_LIMIT {
                stderr.pop_front();
            }
            stderr.push_back(line.replace(password, "[REDACTED]"));
        }
    }

    async fn wait_for_bootstrap(&self) -> Result<DesktopBootstrap, String> {
        let wait = async {
            loop {
                let phase = { self.phase()?.clone() };
                match phase {
                    BackendPhase::Ready(bootstrap) => return Ok(bootstrap),
                    BackendPhase::Failed(message) => return Err(message),
                    BackendPhase::Stopped => return Err("JYYCode backend is stopped".into()),
                    BackendPhase::Starting => {
                        tokio::time::sleep(BOOTSTRAP_POLL_INTERVAL).await;
                    }
                }
            }
        };

        tokio::time::timeout(READY_TIMEOUT, wait)
            .await
            .map_err(|_| "JYYCode backend did not become ready within 20 seconds".to_owned())?
    }

    async fn ensure_ready(&self, app: AppHandle) -> Result<DesktopBootstrap, String> {
        self.start(app).await?;
        self.wait_for_bootstrap().await
    }

    fn stop_owned_child(&self) -> Result<Option<u32>, String> {
        self.inner.stopping.store(true, Ordering::SeqCst);
        self.inner.generation.fetch_add(1, Ordering::SeqCst);
        let pid = self.kill_owned_child()?;
        *self.phase()? = BackendPhase::Stopped;
        Ok(pid)
    }

    pub fn stop(&self) {
        let _ = self.stop_owned_child();
    }

    async fn stop_for_update(&self) -> Result<(), String> {
        let Some(pid) = self.stop_owned_child()? else {
            return Ok(());
        };
        tauri::async_runtime::spawn_blocking(move || wait_for_process_exit(pid))
            .await
            .map_err(|error| format!("failed to wait for JYYCode backend shutdown: {error}"))?
    }

    async fn restart(&self, app: AppHandle) -> Result<(), String> {
        self.stop();
        self.inner.auto_restart_used.store(false, Ordering::SeqCst);
        self.inner.stopping.store(false, Ordering::SeqCst);
        self.start(app).await
    }
}

fn random_password() -> String {
    rand::random::<[u8; 32]>()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn parse_ready(line: &str) -> Result<ReadyLine, String> {
    let value: ReadyLine = serde_json::from_str(line).map_err(|error| error.to_string())?;
    if value.kind != "server.ready" || value.hostname != "127.0.0.1" || value.port == 0 {
        return Err("invalid server.ready payload".into());
    }
    Ok(value)
}

fn push_ready_chunk(buffer: &mut String, bytes: &[u8]) -> Option<ReadyLine> {
    buffer.push_str(&String::from_utf8_lossy(bytes));

    while let Some(newline) = buffer.find('\n') {
        let line = buffer[..newline].trim().to_owned();
        buffer.drain(..=newline);
        if let Ok(ready) = parse_ready(&line) {
            buffer.clear();
            return Some(ready);
        }
    }

    let pending = buffer.trim();
    if let Ok(ready) = parse_ready(pending) {
        buffer.clear();
        return Some(ready);
    }

    if !pending.is_empty() {
        match serde_json::from_str::<serde_json::Value>(pending) {
            Ok(_) => buffer.clear(),
            Err(error) if !error.is_eof() => buffer.clear(),
            Err(_) => {}
        }
    }
    if buffer.len() > STDOUT_BUFFER_LIMIT {
        buffer.clear();
    }
    None
}

#[tauri::command]
pub async fn desktop_bootstrap(
    app: AppHandle,
    state: tauri::State<'_, BackendSupervisor>,
) -> Result<DesktopBootstrap, String> {
    state.inner().ensure_ready(app).await
}

#[tauri::command]
pub async fn restart_backend(
    app: AppHandle,
    state: tauri::State<'_, BackendSupervisor>,
) -> Result<(), String> {
    state.inner().restart(app).await
}

#[tauri::command]
pub async fn stop_backend_for_update(
    state: tauri::State<'_, BackendSupervisor>,
) -> Result<(), String> {
    let supervisor = state.inner().clone();
    supervisor.stop_for_update().await
}

#[cfg(windows)]
fn wait_for_process_exit(pid: u32) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };

    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(87) {
            return Ok(());
        }
        return Err(format!(
            "failed to observe JYYCode backend shutdown: {error}"
        ));
    }

    let result = unsafe { WaitForSingleObject(handle, 5_000) };
    unsafe {
        CloseHandle(handle);
    }
    match result {
        WAIT_OBJECT_0 => Ok(()),
        WAIT_TIMEOUT => Err("JYYCode backend did not stop within 5 seconds".into()),
        _ => Err(format!(
            "failed while waiting for JYYCode backend shutdown: {}",
            std::io::Error::last_os_error()
        )),
    }
}

#[cfg(not(windows))]
fn wait_for_process_exit(_pid: u32) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use super::{BackendPhase, BackendSupervisor, parse_ready, push_ready_chunk};

    #[test]
    fn parses_ready_line() {
        let ready = parse_ready(r#"{"type":"server.ready","hostname":"127.0.0.1","port":49152}"#)
            .expect("valid ready event");
        assert_eq!(ready.hostname, "127.0.0.1");
        assert_eq!(ready.port, 49152);
    }

    #[test]
    fn rejects_non_loopback_ready_line() {
        assert!(
            parse_ready(r#"{"type":"server.ready","hostname":"0.0.0.0","port":49152}"#).is_err()
        );
    }

    #[test]
    fn parses_ready_line_split_across_stdout_chunks() {
        let mut buffer = String::new();
        assert!(push_ready_chunk(&mut buffer, br#"{"type":"server.re"#).is_none());
        let ready = push_ready_chunk(&mut buffer, br#"ady","hostname":"127.0.0.1","port":49152}"#)
            .expect("split ready event");
        assert_eq!(ready.port, 49152);
        assert!(buffer.is_empty());
    }

    #[test]
    fn finds_ready_line_after_other_stdout_lines() {
        let mut buffer = String::new();
        let ready = push_ready_chunk(
            &mut buffer,
            b"not json\n{\"type\":\"server.ready\",\"hostname\":\"127.0.0.1\",\"port\":49153}\n",
        )
        .expect("ready event after log line");
        assert_eq!(ready.port, 49153);
    }

    #[test]
    fn generates_a_32_byte_hex_password() {
        let password = super::random_password();
        assert_eq!(password.len(), 64);
        assert!(password.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn stale_process_generation_cannot_replace_current_state() {
        let supervisor = BackendSupervisor::default();
        supervisor.inner.generation.store(2, Ordering::SeqCst);

        assert!(!supervisor.set_phase_for_generation(1, BackendPhase::Starting));
        assert!(matches!(
            *supervisor.phase().expect("backend phase"),
            BackendPhase::Stopped
        ));
    }
}
