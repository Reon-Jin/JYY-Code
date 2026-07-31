use tauri::Manager;

mod backend;
mod mobile;
mod notifications;
mod project_path;
mod text_file;
mod tunnel;
mod window_effects;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    let _ = fix_path_env::fix();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build());

    // Never run the updater inside a debug/dev build: it would download a real
    // release and launch its installer, which closes the dev app.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    let app = builder
        .invoke_handler(tauri::generate_handler![
            backend::desktop_bootstrap,
            backend::restart_backend,
            backend::stop_backend_for_update,
            mobile::mobile_list_devices,
            mobile::mobile_start_pairing,
            mobile::mobile_pairing_status,
            mobile::mobile_complete_pairing,
            mobile::mobile_revoke_device,
            notifications::send_desktop_notification,
            project_path::create_project_directory,
            project_path::reveal_config_file,
            text_file::save_text_file,
            window_effects::set_window_glass
        ])
        .setup(|app| {
            let supervisor = backend::BackendSupervisor::default();
            app.manage(supervisor.clone());
            let tunnel_supervisor = tunnel::MobileTunnelSupervisor::default();
            tunnel_supervisor.start(&app.handle());
            app.manage(tunnel_supervisor);
            let mobile_companion = mobile::MobileCompanion::load(&app.handle())?;
            mobile::start_relay(mobile_companion.clone(), supervisor.clone());
            app.manage(mobile_companion);
            install_companion_tray(app)?;

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = supervisor.start(handle).await;
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building JYYCode desktop application");

    app.run(|handle, event| {
        if let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } = &event
            && label == "main"
        {
            api.prevent_close();
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            handle.state::<backend::BackendSupervisor>().stop();
            handle.state::<tunnel::MobileTunnelSupervisor>().stop();
        }
    });
}

fn install_companion_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::TrayIconBuilder,
    };

    let show = MenuItem::with_id(app, "show-main-window", "Show JYYCode", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit-jyycode", "Quit JYYCode", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::with_id("mobile-companion")
        .tooltip("JYYCode mobile companion is running")
        .menu(&menu)
        .on_menu_event(|handle, event| match event.id.as_ref() {
            "show-main-window" => show_main_window(handle),
            "quit-jyycode" => handle.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

fn show_main_window(handle: &tauri::AppHandle) {
    if let Some(window) = handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
