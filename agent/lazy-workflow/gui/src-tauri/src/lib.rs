//! The desktop shell around `lz`. The window renders whatever `lz catalog`
//! describes and runs the command the operator composed; every effect still
//! happens inside the CLI, with its own validation, run log and checkpoints.
//! This crate only finds the binary, gives it the operator's environment,
//! streams its output, and keeps the GUI's own settings file.

mod environment;
mod run_log;
mod runner;
mod settings;

use runner::{Captured, RunRequest, RunStarted, Runs};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use settings::GuiSettings;
use std::time::Duration;
use tauri::State;

/// The catalog schema this window renders; a newer CLI that changes its meaning bumps it.
const CATALOG_SCHEMA_VERSION: u64 = 1;

fn current_settings() -> Result<GuiSettings, String> {
    settings::load(&settings::settings_path())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsDocument {
    path: String,
    settings: GuiSettings,
    error: Option<String>,
}

/// The settings with their path; a malformed file comes back as the defaults plus the error, so the window can still open.
#[tauri::command]
fn get_settings() -> SettingsDocument {
    let path = settings::settings_path();
    match settings::load(&path) {
        Ok(settings) => SettingsDocument { path: path.to_string_lossy().into_owned(), settings, error: None },
        Err(error) => SettingsDocument { path: path.to_string_lossy().into_owned(), settings: GuiSettings::default(), error: Some(error) },
    }
}

#[tauri::command]
fn save_settings(settings: GuiSettings) -> Result<SettingsDocument, String> {
    let path = settings::settings_path();
    settings::save(&path, &settings)?;
    environment::reload_shell_environment();
    Ok(SettingsDocument { path: path.to_string_lossy().into_owned(), settings, error: None })
}

/// `lz catalog`, parsed; the error names the fix when the binary is missing or predates the command.
#[tauri::command]
async fn load_catalog() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let settings = current_settings()?;
        let captured = runner::capture(&settings, &["catalog".to_string()], Duration::from_secs(60))?;
        if captured.code != Some(0) {
            return Err(format!(
                "`lz catalog` fallo (codigo {}): {}. Si tu lz es anterior a la GUI, ejecuta `lz update`.",
                captured.code.map_or("?".into(), |code| code.to_string()),
                captured.stderr.trim()
            ));
        }
        let catalog: Value = serde_json::from_str(&captured.stdout).map_err(|error| format!("`lz catalog` no imprimio JSON valido: {error}"))?;
        match catalog.get("schemaVersion").and_then(Value::as_u64) {
            Some(CATALOG_SCHEMA_VERSION) => Ok(catalog),
            other => Err(format!("el catalogo de lz usa el esquema {other:?}; esta GUI entiende el {CATALOG_SCHEMA_VERSION}: actualiza la GUI")),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Off the async runtime: resolving `secretEnvironment` runs `lz credentials-get`, which blocks.
#[tauri::command]
async fn start_run(app: tauri::AppHandle, runs: State<'_, Runs>, request: RunRequest) -> Result<RunStarted, String> {
    let runs = runs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runs.start(app, &current_settings()?, request))
        .await
        .map_err(|error| error.to_string())?
}

/// `true` when this cancel killed the run instead of interrupting it.
#[tauri::command]
fn cancel_run(runs: State<'_, Runs>, id: u64) -> Result<bool, String> {
    runs.cancel(id)
}

#[tauri::command]
async fn read_run_log(limit: Option<usize>) -> Result<run_log::RunLog, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = current_settings()?;
        let path = run_log::run_log_path(&environment::run_environment(&settings));
        run_log::read(&path, limit.unwrap_or(4000))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentProbe {
    name: String,
    secret: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbedVariable {
    name: String,
    present: bool,
    /// Never set for a secret.
    value: Option<String>,
    source: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbedBinary {
    name: String,
    path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostics {
    settings_path: String,
    run_log_path: String,
    lz_launcher: Option<String>,
    lz_error: Option<String>,
    shell_environment: bool,
    binaries: Vec<ProbedBinary>,
    variables: Vec<ProbedVariable>,
}

const PROBED_BINARIES: [&str; 9] = ["lz", "bun", "git", "gh", "az", "opencode", "claude", "codex", "chezmoi"];

/// What a run would find: the launcher, the tools the CLI shells out to, and which variables are set — never a secret's value.
#[tauri::command]
async fn diagnose(variables: Vec<EnvironmentProbe>) -> Result<Diagnostics, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = current_settings()?;
        let run_environment = environment::run_environment(&settings);
        let lz = environment::resolve_launcher(&settings, &run_environment).map(|launcher| {
            std::iter::once(launcher.program.to_string_lossy().into_owned()).chain(launcher.prefix).collect::<Vec<_>>().join(" ")
        });
        Ok(Diagnostics {
            settings_path: settings::settings_path().to_string_lossy().into_owned(),
            run_log_path: run_log::run_log_path(&run_environment).to_string_lossy().into_owned(),
            lz_launcher: lz.as_ref().ok().cloned(),
            lz_error: lz.err(),
            shell_environment: settings.inherit_shell_environment && environment::shell_environment().is_some(),
            binaries: PROBED_BINARIES
                .iter()
                .map(|name| ProbedBinary { name: name.to_string(), path: environment::which(name, &run_environment).map(|path| path.to_string_lossy().into_owned()) })
                .collect(),
            variables: variables
                .into_iter()
                .map(|probe| {
                    let from_settings = settings.secret_environment.iter().any(|name| name == &probe.name);
                    let value = run_environment.get(&probe.name).filter(|value| !value.is_empty());
                    ProbedVariable {
                        present: value.is_some() || from_settings,
                        value: if probe.secret { None } else { value.cloned() },
                        source: if value.is_some() {
                            if settings.environment.contains_key(&probe.name) { "settings" } else { "environment" }
                        } else if from_settings {
                            "credentials"
                        } else {
                            "missing"
                        },
                        name: probe.name,
                    }
                })
                .collect(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Re-reads the login shell's environment, after the operator edits their profile.
#[tauri::command]
fn reload_environment() {
    environment::reload_shell_environment();
}

/// Runs a short `lz` command to completion: a read the window needs without opening a run tab.
#[tauri::command]
async fn capture_lz(args: Vec<String>) -> Result<Captured, String> {
    tauri::async_runtime::spawn_blocking(move || runner::capture(&current_settings()?, &args, Duration::from_secs(120)))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Warm the shell environment off the main thread; the first run would wait for it otherwise.
    std::thread::spawn(|| {
        if current_settings().map(|settings| settings.inherit_shell_environment).unwrap_or(true) {
            let _ = environment::shell_environment();
        }
    });
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Runs::default())
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
        .run(tauri::generate_context!())
        .expect("error while running the lz GUI");
}
