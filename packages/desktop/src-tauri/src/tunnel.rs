use std::{
    fs,
    path::PathBuf,
    process::{Child, Command},
    sync::{Arc, Mutex},
};

use tauri::AppHandle;

/// Owns the local Quick Tunnel launcher for the lifetime of the desktop app.
/// The PowerShell launcher watches this process ID and stops its Bun relay and
/// cloudflared child when JYYCode exits, including after an unexpected crash.
#[derive(Clone, Default)]
pub struct MobileTunnelSupervisor {
    child: Arc<Mutex<Option<Child>>>,
    stop_file: Arc<Mutex<Option<PathBuf>>>,
}

impl MobileTunnelSupervisor {
    pub fn start(&self, app: &AppHandle) {
        #[cfg(windows)]
        {
            let Some(script) = launcher_script(app) else { return };
            let Ok(mut guard) = self.child.lock() else { return };
            if guard.as_ref().is_some_and(|child| child.id() > 0) {
                return;
            }

            let stop_file = tunnel_stop_file();
            let _ = fs::remove_file(&stop_file);

            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ]);
            command.arg(script);
            let desktop_pid = std::process::id().to_string();
            command.args([
                "-ForceTryCloudflareIPv4",
                "-DesktopPid",
                &desktop_pid,
                "-StopFile",
            ]);
            command.arg(&stop_file);
            #[allow(unused_imports)]
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW: the script communicates its current URL in the
            // desktop Settings page, so a terminal window is not needed.
            command.creation_flags(0x0800_0000);
            if let Ok(child) = command.spawn() {
                *guard = Some(child);
                if let Ok(mut configured_stop_file) = self.stop_file.lock() {
                    *configured_stop_file = Some(stop_file);
                }
            }
        }
    }

    pub fn stop(&self) {
        // Tell the script to execute its normal cleanup block. This is more
        // reliable than killing its PowerShell parent, which could otherwise
        // orphan cloudflared and Bun. The PID monitor remains the crash-safe
        // fallback if the process ends before this signal is written.
        if let Ok(stop_file) = self.stop_file.lock()
            && let Some(stop_file) = stop_file.as_ref()
        {
            let _ = fs::write(stop_file, "desktop-exiting");
        }
        if let Ok(mut guard) = self.child.lock() {
            *guard = None;
        }
    }
}

#[cfg(windows)]
fn tunnel_stop_file() -> PathBuf {
    let directory = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|path| path.join("JYYCode"))
        .unwrap_or_else(std::env::temp_dir);
    directory.join(format!("mobile-tunnel-stop-{}.signal", std::process::id()))
}

#[cfg(windows)]
fn launcher_script(_app: &AppHandle) -> Option<PathBuf> {
    // On a portable Windows build, Tauri's executable-dir resolver can point
    // at a bundle resource directory rather than the running .exe directory.
    // `current_exe` is the authoritative location for both portable and
    // installed builds.
    let executable_directory = std::env::current_exe().ok()?.parent()?.to_path_buf();
    executable_directory
        .ancestors()
        .map(|directory| directory.join("script").join("start-safari-quick-tunnel.ps1"))
        .find(|candidate| candidate.is_file())
}
