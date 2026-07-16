use tauri::Manager;

mod backend;
mod project_path;
mod window_effects;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            backend::desktop_bootstrap,
            backend::restart_backend,
            project_path::create_project_directory,
            project_path::reveal_config_file,
            window_effects::set_window_glass
        ])
        .setup(|app| {
            let supervisor = backend::BackendSupervisor::default();
            app.manage(supervisor.clone());

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = supervisor.start(handle).await;
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building JYYCode desktop application");

    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            handle.state::<backend::BackendSupervisor>().stop();
        }
    });
}
