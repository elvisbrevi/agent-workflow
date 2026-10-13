//! Tauri commands only adapt the shared core to the window's IPC and event bus.
use crate::{
    core::{Core, Diagnostics, EnvironmentProbe, SettingsDocument},
    desktop_tray, environment, run_log,
    runner::{Captured, RunRequest, RunStarted},
    settings::{self, GuiSettings},
};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tauri::{Emitter, Manager, State};

#[tauri::command]
fn get_settings(core: State<'_, Core>) -> SettingsDocument {
    core.get_settings()
}

#[tauri::command]
fn save_settings(core: State<'_, Core>, settings: GuiSettings) -> Result<SettingsDocument, String> {
    core.save_settings(settings)
}

#[tauri::command]
async fn load_catalog(core: State<'_, Core>) -> Result<Value, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.load_catalog())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn start_run(
    app: tauri::AppHandle,
    core: State<'_, Core>,
    request: RunRequest,
) -> Result<RunStarted, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let events_app = app.clone();
        let result = core.start(
            Arc::new(move |event, payload| {
                let _ = events_app.emit(event, payload);
                if event == crate::runner::EXIT_EVENT {
                    desktop_tray::refresh_status(&events_app);
                }
            }),
            request,
        );
        desktop_tray::refresh_status(&app);
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn cancel_run(core: State<'_, Core>, id: u64) -> Result<bool, String> {
    core.runs.cancel(id)
}

#[tauri::command]
async fn read_run_log(
    core: State<'_, Core>,
    limit: Option<usize>,
) -> Result<run_log::RunLog, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.read_run_log(limit.unwrap_or(4000)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn diagnose(
    core: State<'_, Core>,
    variables: Vec<EnvironmentProbe>,
) -> Result<Diagnostics, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.diagnose(variables))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn reload_environment() {
    environment::reload_shell_environment();
}

#[tauri::command]
fn get_update_status(core: State<'_, Core>) -> Value {
    serde_json::json!({"installedCommit":crate::core::installed_commit(), "activeRuns":core.runs.active_count(), "updating":false, "job":null, "log":""})
}

#[tauri::command]
async fn capture_lz(core: State<'_, Core>, args: Vec<String>) -> Result<Captured, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.capture(&args, Duration::from_secs(120)))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let core = Core::open(settings::settings_path()).expect("cannot open the lz GUI profile");
    let warm = core.clone();
    std::thread::spawn(move || {
        if warm
            .settings()
            .map(|settings| settings.inherit_shell_environment)
            .unwrap_or(true)
        {
            let _ = environment::shell_environment();
        }
    });
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(core)
        .setup(|app| Ok(desktop_tray::install(app)?))
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // Keep the webview and its runs alive; explicit Quit still shuts down.
                    if window.hide().is_ok() {
                        api.prevent_close();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            load_catalog,
            start_run,
            cancel_run,
            read_run_log,
            diagnose,
            reload_environment,
            get_update_status,
            capture_lz
        ])
        .build(tauri::generate_context!())
        .expect("error while building the lz GUI")
        .run(|app, event| match event {
            tauri::RunEvent::Exit => app.state::<Core>().runs.shutdown(),
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => desktop_tray::show_main_window(app),
            _ => {}
        });
}
