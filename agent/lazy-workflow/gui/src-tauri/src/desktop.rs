//! Tauri commands only adapt the shared core to the window's IPC and event bus.
use crate::{
    core::{Core, Diagnostics, EnvironmentProbe, SettingsDocument},
    environment, run_log,
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
        core.start(
            Arc::new(move |event, payload| {
                let _ = app.emit(event, payload);
            }),
            request,
        )
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
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            load_catalog,
            start_run,
            cancel_run,
            read_run_log,
            diagnose,
            reload_environment,
            capture_lz
        ])
        .build(tauri::generate_context!())
        .expect("error while building the lz GUI")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<Core>().runs.shutdown();
            }
        });
}
