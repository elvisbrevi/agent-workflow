//! Maintenance has fixed authority and runs in a service-manager job outside the backend.
use super::{auth, config::private_write, policy, WebState};
use crate::{environment, settings};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::{Read, Seek, SeekFrom}, path::{Path, PathBuf}, process::{Command, Stdio}};

const UPDATE_ENVIRONMENT: [&str; 6] = ["PATH", "CARGO_HOME", "RUSTUP_HOME", "CODEX_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    id: String,
    status: String,
    message: String,
}

fn job(data: &Path) -> Result<Option<Job>, String> {
    let path = data.join("update.json");
    if !path.exists() { return Ok(None); }
    let job: Job = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|_| "invalid update record")?;
    if job.id.is_empty() || !job.id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') { return Err("invalid update ID".into()); }
    Ok(Some(job))
}

pub fn blocked(data: &Path) -> bool { data.join("update.lock").exists() || data.join("installer-update.lock").exists() }

pub fn status(state: &WebState) -> Result<Value, String> {
    let job = job(&state.data_dir)?;
    let mut log = String::new();
    if let Some(job) = &job {
        let path = state.data_dir.join("logs").join(format!("update-{}.log", job.id));
        if path.exists() {
            let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
            let length = file.metadata().map_err(|e| e.to_string())?.len();
            file.seek(SeekFrom::Start(length.saturating_sub(65536))).map_err(|e| e.to_string())?;
            let mut bytes = Vec::new(); file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            log = String::from_utf8_lossy(&bytes).into_owned();
        }
    }
    Ok(json!({"installedCommit":crate::core::installed_commit(), "activeRuns":state.core.runs.active_count(), "updating":blocked(&state.data_dir), "job":job, "log":log}))
}

fn installed_launcher(profile: &settings::GuiSettings) -> Result<environment::Launcher, String> {
    let env = environment::run_environment(profile);
    let launcher = environment::resolve_launcher(profile, &env)?;
    let script = launcher.prefix.last().map(PathBuf::from).unwrap_or_else(|| launcher.program.clone());
    let resolved = script.canonicalize().map_err(|_| "installed lz not found")?;
    let cache = settings::home_dir().join(".cache/agent-workflow/agent/lazy-workflow").canonicalize().map_err(|_| "installed cache not found")?;
    if resolved != cache.join("main.ts") && resolved != cache.join("run.sh") {
        return Err("La web usa un lzCommand fuera del cache. Migralo localmente al lz instalado antes de actualizar.".into());
    }
    Ok(launcher)
}

/// The browser cannot select a ref, destination, repository URL, executable or flags.
fn job_command(platform: &str, id: &str, worker: &Path, data: &Path, environment: &[String], uid: u32) -> Result<(Vec<String>, Option<String>), String> {
    let mut worker_args = vec!["/usr/bin/env".to_string(), "-i".into()];
    worker_args.extend_from_slice(environment);
    worker_args.extend([worker.display().to_string(), "update-worker".into(), "--data-dir".into(), data.display().to_string()]);
    match platform {
        "linux" => {
            let mut args = vec!["systemd-run".into(), "--user".into(), "--collect".into(), format!("--unit=lz-web-update-{id}"), "--property=Type=exec".into(), "--property=UMask=0077".into(), "--".into()];
            // systemd expands dollars in ExecStart even without a shell.
            args.extend(worker_args.into_iter().map(|arg| arg.replace('$', "$$")));
            Ok((args, None))
        }
        "macos" => {
            let xml = |value: &str| value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
            let arguments = worker_args.iter().map(|arg| format!("<string>{}</string>", xml(arg))).collect::<String>();
            let plist = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>Label</key><string>com.elvisbrevi.lz-web.update.{id}</string><key>ProgramArguments</key><array>{arguments}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>Umask</key><integer>63</integer></dict></plist>");
            Ok((vec!["launchctl".into(), "bootstrap".into(), format!("gui/{uid}"), worker.with_extension("plist").display().to_string()], Some(plist)))
        }
        _ => Err("Web update requires Linux systemd or macOS launchd".into()),
    }
}

pub fn start(state: &WebState, body: &Value) -> Result<Value, String> {
    policy::update_request(body)?;
    let _gate = state.starts.lock().unwrap();
    if state.core.runs.active_count() != 0 { return Err("Hay ejecuciones activas; termina las ejecuciones antes de actualizar.".into()); }
    if blocked(&state.data_dir) { return Err("La instalacion tiene una actualizacion o recuperacion pendiente; revisa su progreso localmente.".into()); }
    installed_launcher(&state.core.settings()?)?;
    if !state.data_dir.join("service.json").is_file() { return Err("Install the managed web services locally first".into()); }
    let lock = state.data_dir.join("update.lock");
    fs::create_dir(&lock).map_err(|_| "Ya hay una actualizacion; revisa su progreso.")?;
    let id = auth::random_token();
    let result = (|| {
        fs::write(lock.join("id"), &id).map_err(|e| e.to_string())?;
        let directory = state.data_dir.join("logs").join(format!("update-{id}"));
        super::config::private_directory(&directory)?;
        let worker = directory.join("worker");
        fs::copy(std::env::current_exe().map_err(|e| e.to_string())?, &worker).map_err(|e| e.to_string())?;
        let mut env = vec![format!("HOME={}", settings::home_dir().display())];
        let profile_env = environment::run_environment(&state.core.settings()?);
        for key in UPDATE_ENVIRONMENT {
            if let Some(value) = profile_env.get(key) {
                let value = if key == "PATH" { format!("{}:{}", settings::home_dir().join(".cargo/bin").display(), value) } else { value.clone() };
                env.push(format!("{key}={value}"));
            }
        }
        #[cfg(unix)]
        let uid = unsafe { libc::getuid() };
        #[cfg(not(unix))]
        let uid = 0;
        let (args, plist) = job_command(std::env::consts::OS, &id, &worker, &state.data_dir, &env, uid)?;
        if let Some(plist) = plist { fs::write(worker.with_extension("plist"), plist).map_err(|e| e.to_string())?; }
        private_write(&state.data_dir.join("update.json"), &Job { id: id.clone(), status: "queued".into(), message: "Actualizacion programada; preparando el instalador.".into() })?;
        let result = Command::new(&args[0]).args(&args[1..]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|_| "No se pudo programar la actualizacion en el gestor de servicios")?;
        if !result.success() { return Err("El gestor de servicios rechazo la actualizacion; revisa systemd/launchd localmente.".into()); }
        status(state)
    })();
    if result.is_err() {
        let _ = private_write(&state.data_dir.join("update.json"), &Job { id, status: "failed".into(), message: "No se pudo programar la actualizacion; revisa el gestor de servicios.".into() });
        let _ = fs::remove_dir_all(lock);
    }
    result
}

/// The copied worker survives replacement of both its original binary and the CLI cache.
pub fn worker(data: PathBuf) -> Result<(), String> {
    super::config::outside_checkout(&data)?;
    let _lease = crate::core::acquire_profile_lease(data.join("update-worker.lock"))?;
    let mut job = job(&data)?.ok_or("no queued update")?;
    if job.status != "queued" || fs::read_to_string(data.join("update.lock/id")).ok().as_deref() != Some(&job.id) { return Err("no matching queued update".into()); }
    job.status = "running".into(); job.message = "Actualizando desde main; el servicio se reconectara al terminar.".into();
    private_write(&data.join("update.json"), &job)?;
    let result = (|| {
        let config: super::config::WebConfig = serde_json::from_slice(&fs::read(data.join("web.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let profile = settings::load(&config.settings_path)?;
        let launcher = installed_launcher(&profile)?;
        let log = fs::OpenOptions::new().create_new(true).write(true).open(data.join("logs").join(format!("update-{}.log", job.id))).map_err(|e| e.to_string())?;
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; log.set_permissions(fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?; }
        let env = environment::run_environment(&profile);
        let mut command = Command::new(&launcher.program);
        command.env_clear().env("HOME", settings::home_dir());
        for key in UPDATE_ENVIRONMENT {
            if let Some(value) = env.get(key) { command.env(key, value); }
        }
        command.env("LZ_WEB_DATA_DIR", &data).env("LZ_WEB_UPDATE_ID", &job.id);
        let status = command.args(&launcher.prefix).args(["update", "--all-global", "--ref", "main"])
            .current_dir(settings::home_dir()).stdin(Stdio::null()).stdout(log.try_clone().map_err(|e| e.to_string())?).stderr(log)
            .status().map_err(|_| "No se pudo iniciar el lz instalado")?;
        if !status.success() { return Err("La actualizacion fallo; revisa el progreso y el respaldo antes de reintentar.".into()); }
        Ok(())
    })();
    job.status = if result.is_ok() { "succeeded" } else { "failed" }.into();
    job.message = result.as_ref().err().cloned().unwrap_or_else(|| "Actualizacion terminada; la pagina cargara la version nueva.".into());
    if data.join("installer-update.lock").exists() { job.message = "La actualizacion se interrumpio o no pudo verificar la restauracion; requiere recuperacion local antes de reanudar ejecuciones.".into(); }
    private_write(&data.join("update.json"), &job)?;
    fs::remove_dir_all(data.join("update.lock")).map_err(|e| e.to_string())?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn an_interrupted_installer_keeps_admission_closed_even_if_its_worker_finished() {
        let data = tempfile::tempdir().unwrap();
        fs::create_dir(data.path().join("installer-update.lock")).unwrap();
        assert!(blocked(data.path()));
    }
    #[test]
    fn service_manager_jobs_run_a_fixed_worker_outside_the_backend() {
        for platform in ["linux", "macos"] {
            let (args, plist) = job_command(platform, "synthetic", Path::new("/private/worker"), Path::new("/private/data"), &["HOME=/synthetic".into()], 501).unwrap();
            if let Some(plist) = plist {
                assert!(plist.contains("<key>KeepAlive</key><false/>"));
                assert!(plist.contains("<string>update-worker</string>"));
                assert_eq!(args, ["launchctl", "bootstrap", "gui/501", "/private/worker.plist"]);
            } else {
                assert_eq!(&args[args.len()-4..], ["/private/worker", "update-worker", "--data-dir", "/private/data"]);
                assert!(args.contains(&"-i".into()));
                assert!(args.contains(&"--property=Type=exec".into()));
            }
            assert!(!args.iter().any(|arg| arg == "--ref" || arg == "--target"));
            assert_eq!(args[0], if platform == "linux" { "systemd-run" } else { "launchctl" });
        }
    }
}
