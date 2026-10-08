//! Running `lz`: one child process per run, its stdout and stderr streamed to
//! the window line by line, and a cancel that behaves like Ctrl-C.
//!
//! The CLI already knows how to be interrupted — SIGINT records the run as
//! interrupted in the run log, cancels a pending `--off` and names the
//! checkpoint to reconcile — so the first cancel sends exactly that to the
//! run's whole process group (the coding agent included), as a terminal would.
//! Only a second cancel kills the group outright.

use crate::environment::{resolve_launcher, run_environment, Launcher};
use crate::settings::{home_dir, GuiSettings};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub const OUTPUT_EVENT: &str = "lz://run-output";
pub const EXIT_EVENT: &str = "lz://run-exit";

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    /// The arguments after `lz`, command first.
    pub args: Vec<String>,
    /// Written to the child's stdin and closed: the value `credentials-set --stdin` stores.
    pub stdin: Option<String>,
    /// The directory the child starts in; the active repository when omitted.
    pub cwd: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunStarted {
    pub id: u64,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub started_at: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct OutputLine {
    id: u64,
    stream: &'static str,
    line: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct RunExit {
    id: u64,
    code: Option<i32>,
    signal: Option<i32>,
    duration_ms: u64,
    cancelled: bool,
    error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Captured {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

struct Running {
    pid: u32,
    cancels: u32,
}

/// Cheap to clone: every clone shares the same registry, so a blocking task can own one.
#[derive(Default, Clone)]
pub struct Runs {
    next: Arc<AtomicU64>,
    running: Arc<Mutex<HashMap<u64, Running>>>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0)
}

/// The variables the settings mark secret, read from the CLI's own credential
/// store at the moment of the run, so the GUI never stores or displays them.
/// A name the environment already carries is left as it is.
fn resolve_secrets(settings: &GuiSettings, launcher: &Launcher, environment: &mut BTreeMap<String, String>) -> Result<(), String> {
    for name in &settings.secret_environment {
        let name = name.trim();
        if name.is_empty() || environment.get(name).is_some_and(|value| !value.is_empty()) {
            continue;
        }
        let args = vec!["credentials-get".to_string(), "--name".into(), name.into(), "--force".into()];
        let captured = capture_with(launcher, environment, &args, None, Duration::from_secs(30))?;
        match captured.code {
            Some(0) => {
                environment.insert(name.to_string(), captured.stdout.trim_end_matches(['\r', '\n']).to_string());
            }
            _ => return Err(format!("no se pudo resolver el secreto {name} con lz credentials-get: {}", captured.stderr.trim())),
        }
    }
    Ok(())
}

fn command_for(launcher: &Launcher, environment: &BTreeMap<String, String>, args: &[String], cwd: &PathBuf) -> Command {
    let mut command = Command::new(&launcher.program);
    command.args(&launcher.prefix).args(args).env_clear().envs(environment).current_dir(cwd);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group, so a cancel reaches the agent CLI the run spawned too.
        command.process_group(0);
        // A GUI started in the background of a script inherits SIGINT and SIGQUIT
        // ignored, and a shell cannot trap a signal ignored on entry: the run
        // starts with the default dispositions a terminal would give it, so the
        // first cancel still interrupts it.
        // SAFETY: only `sigaction`, which is async-signal-safe, runs between fork and exec.
        unsafe {
            command.pre_exec(|| {
                for signal in [libc::SIGINT, libc::SIGQUIT] {
                    let mut action: libc::sigaction = std::mem::zeroed();
                    action.sa_sigaction = libc::SIG_DFL;
                    libc::sigaction(signal, &action, std::ptr::null_mut());
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn default_cwd(settings: &GuiSettings) -> PathBuf {
    settings.active_repository.as_ref().map(PathBuf::from).filter(|path| path.is_dir()).unwrap_or_else(home_dir)
}

fn write_stdin(child: &mut Child, input: Option<String>) {
    if let (Some(mut stdin), Some(input)) = (child.stdin.take(), input) {
        std::thread::spawn(move || {
            let _ = stdin.write_all(input.as_bytes());
            if !input.ends_with('\n') {
                let _ = stdin.write_all(b"\n");
            }
        });
    }
}

/// Runs `lz` to completion and returns what it printed; used for `catalog`, secrets and probes.
pub fn capture_with(launcher: &Launcher, environment: &BTreeMap<String, String>, args: &[String], cwd: Option<PathBuf>, timeout: Duration) -> Result<Captured, String> {
    let cwd = cwd.unwrap_or_else(home_dir);
    let mut child = command_for(launcher, environment, args, &cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("no se pudo ejecutar {}: {error}", launcher.program.display()))?;
    drop(child.stdin.take());
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let err = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) => break status,
            None if started.elapsed() > timeout => {
                kill_group(child.id(), true);
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("lz {} no termino en {}s", args.join(" "), timeout.as_secs()));
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    Ok(Captured { code: status.code(), stdout: out.join().unwrap_or_default(), stderr: err.join().unwrap_or_default() })
}

pub fn capture(settings: &GuiSettings, args: &[String], timeout: Duration) -> Result<Captured, String> {
    let environment = run_environment(settings);
    let launcher = resolve_launcher(settings, &environment)?;
    capture_with(&launcher, &environment, args, Some(default_cwd(settings)), timeout)
}

fn stream(app: AppHandle, id: u64, name: &'static str, reader: impl Read + Send + 'static) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buffer).trim_end_matches(['\r', '\n']).to_string();
                    let _ = app.emit(OUTPUT_EVENT, OutputLine { id, stream: name, line });
                }
            }
        }
    })
}

#[cfg(unix)]
fn signal_of(status: &ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn signal_of(_status: &ExitStatus) -> Option<i32> {
    None
}

impl Runs {
    pub fn start(&self, app: AppHandle, settings: &GuiSettings, request: RunRequest) -> Result<RunStarted, String> {
        if request.args.is_empty() {
            return Err("falta el comando de lz".into());
        }
        let mut environment = run_environment(settings);
        let launcher = resolve_launcher(settings, &environment)?;
        resolve_secrets(settings, &launcher, &mut environment)?;
        let cwd = request.cwd.as_ref().map(PathBuf::from).filter(|path| path.is_dir()).unwrap_or_else(|| default_cwd(settings));
        let mut child = command_for(&launcher, &environment, &request.args, &cwd)
            .stdin(if request.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("no se pudo ejecutar {}: {error}", launcher.program.display()))?;

        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let started = Instant::now();
        let started_at = now_ms();
        self.running.lock().unwrap().insert(id, Running { pid: child.id(), cancels: 0 });
        write_stdin(&mut child, request.stdin);
        let readers = [
            stream(app.clone(), id, "stdout", child.stdout.take().unwrap()),
            stream(app.clone(), id, "stderr", child.stderr.take().unwrap()),
        ];

        let running = Arc::clone(&self.running);
        std::thread::spawn(move || {
            let waited = child.wait();
            for reader in readers {
                let _ = reader.join();
            }
            let cancelled = running.lock().unwrap().remove(&id).map(|run| run.cancels > 0).unwrap_or(false);
            let (code, signal, error) = match waited {
                Ok(status) => (status.code(), signal_of(&status), None),
                Err(error) => (None, None, Some(error.to_string())),
            };
            let _ = app.emit(EXIT_EVENT, RunExit { id, code, signal, duration_ms: started.elapsed().as_millis() as u64, cancelled, error });
        });

        let mut shown = launcher.prefix.clone();
        shown.extend(request.args.iter().cloned());
        Ok(RunStarted { id, program: launcher.program.to_string_lossy().into_owned(), args: shown, cwd: cwd.to_string_lossy().into_owned(), started_at })
    }

    /// First call: SIGINT to the run's process group, as Ctrl-C. Any later call: kill it.
    pub fn cancel(&self, id: u64) -> Result<bool, String> {
        let mut running = self.running.lock().unwrap();
        let run = running.get_mut(&id).ok_or("el run ya termino")?;
        run.cancels += 1;
        let force = run.cancels > 1;
        kill_group(run.pid, force);
        Ok(force)
    }
}

#[cfg(unix)]
fn kill_group(pid: u32, force: bool) {
    let signal = if force { libc::SIGKILL } else { libc::SIGINT };
    // SAFETY: plain syscall; a negative pid addresses the process group the child leads.
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
}

#[cfg(windows)]
fn kill_group(pid: u32, _force: bool) {
    // Windows has no SIGINT for a windowless child: end the whole tree.
    let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn shell(script: &str) -> (Launcher, BTreeMap<String, String>, Vec<String>) {
        let launcher = Launcher { program: PathBuf::from("/bin/sh"), prefix: vec!["-c".into()] };
        (launcher, std::env::vars().collect(), vec![script.to_string()])
    }

    /// A launcher that is the script itself, so the arguments a caller adds become `$0`, `$1`…
    fn script_launcher(script: &str) -> (Launcher, BTreeMap<String, String>) {
        (Launcher { program: PathBuf::from("/bin/sh"), prefix: vec!["-c".into(), script.into()] }, std::env::vars().collect())
    }

    #[test]
    fn capture_returns_both_streams_and_the_exit_code() {
        let (launcher, environment, args) = shell("echo out; echo err >&2; exit 3");
        let captured = capture_with(&launcher, &environment, &args, None, Duration::from_secs(10)).unwrap();
        assert_eq!((captured.code, captured.stdout.as_str(), captured.stderr.as_str()), (Some(3), "out\n", "err\n"));
    }

    #[test]
    fn secrets_come_from_credentials_get_and_never_override_the_environment() {
        // `sh -c SCRIPT credentials-get --name NAME --force` puts the command in $0 and the name in $2.
        let (launcher, mut environment) = script_launcher(r#"[ "$0" = credentials-get ] && [ "$3" = --force ] && echo "value-of-$2""#);
        environment.insert("ALREADY_SET".into(), "kept".into());
        let settings = GuiSettings { secret_environment: vec!["SECRET_A".into(), "ALREADY_SET".into()], ..GuiSettings::default() };
        resolve_secrets(&settings, &launcher, &mut environment).unwrap();
        assert_eq!(environment["SECRET_A"], "value-of-SECRET_A");
        assert_eq!(environment["ALREADY_SET"], "kept");

        let (failing, mut environment) = script_launcher("echo 'credentials-get: no existe' >&2; exit 1");
        let settings = GuiSettings { secret_environment: vec!["MISSING".into()], ..GuiSettings::default() };
        let error = resolve_secrets(&settings, &failing, &mut environment).unwrap_err();
        assert!(error.contains("MISSING") && error.contains("no existe"), "{error}");
    }

    #[test]
    fn the_first_cancel_interrupts_a_run_even_when_the_gui_ignores_sigint() {
        // What a GUI started in the background of a script inherits.
        // SAFETY: changes this test process's own disposition; nothing here sends it SIGINT.
        unsafe {
            libc::signal(libc::SIGINT, libc::SIG_IGN);
        }
        let (launcher, environment, args) = shell("trap 'exit 130' INT; while :; do sleep 0.05; done");
        let mut child = command_for(&launcher, &environment, &args, &std::env::temp_dir())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        kill_group(child.id(), false);
        let started = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if started.elapsed() > Duration::from_secs(5) {
                kill_group(child.id(), true);
                let _ = child.wait();
                panic!("SIGINT did not interrupt the run");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(status.code(), Some(130));
    }
}
