//! The environment a run executes in, and where its programs are found.
//!
//! A desktop app does not start from a terminal: on macOS it gets a minimal
//! PATH without `~/.local/bin` (where the installer puts `lz`) or `~/.bun/bin`,
//! and none of the `LAZY_WORKFLOW_*` variables an operator exports in their
//! shell profile. Reading the login shell's environment once, then layering the
//! GUI settings on top, gives a run the same world the operator's terminal has.

use crate::settings::{home_dir, GuiSettings};
use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const BEGIN: &str = "__LZ_GUI_ENV_BEGIN__";
const END: &str = "__LZ_GUI_ENV_END__";
const SHELL_TIMEOUT: Duration = Duration::from_secs(8);

/// The login shell's environment, read once; `None` when it could not be read.
static SHELL_ENVIRONMENT: Mutex<Option<Option<HashMap<String, String>>>> = Mutex::new(None);

/// Forgets the cached shell environment so the next run reads it again.
pub fn reload_shell_environment() {
    *SHELL_ENVIRONMENT.lock().unwrap() = None;
}

pub fn shell_environment() -> Option<HashMap<String, String>> {
    let mut cached = SHELL_ENVIRONMENT.lock().unwrap();
    if cached.is_none() {
        *cached = Some(read_login_shell_environment());
    }
    cached.clone().unwrap()
}

#[cfg(windows)]
fn read_login_shell_environment() -> Option<HashMap<String, String>> {
    // A Windows app already inherits the user's environment from Explorer.
    None
}

#[cfg(not(windows))]
fn read_login_shell_environment() -> Option<HashMap<String, String>> {
    let shell = std::env::var("SHELL").ok().filter(|shell| !shell.is_empty()).unwrap_or_else(|| "/bin/sh".into());
    let script = format!("printf '%s' {BEGIN}; env -0; printf '%s' {END}");
    let mut child = Command::new(&shell)
        .args(["-l", "-i", "-c", &script])
        .env("DISABLE_AUTO_UPDATE", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let mut stdout = stdout;
        let _ = std::io::Read::read_to_end(&mut stdout, &mut buffer);
        buffer
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < SHELL_TIMEOUT => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    parse_shell_output(&String::from_utf8_lossy(&reader.join().ok()?))
}

/// The `NAME=value` records between the markers, NUL-separated as `env -0` prints them.
pub fn parse_shell_output(output: &str) -> Option<HashMap<String, String>> {
    let start = output.find(BEGIN)? + BEGIN.len();
    let end = output[start..].find(END)? + start;
    let variables: HashMap<String, String> = output[start..end]
        .split('\0')
        .filter_map(|record| {
            let (name, value) = record.split_once('=')?;
            (!name.is_empty() && !name.contains('\n')).then(|| (name.to_string(), value.to_string()))
        })
        .collect();
    (!variables.is_empty()).then_some(variables)
}

/// Directories a GUI-launched process commonly lacks, appended last.
fn fallback_path_entries() -> Vec<PathBuf> {
    let home = home_dir();
    let mut entries = vec![home.join(".local").join("bin"), home.join(".bun").join("bin")];
    if !cfg!(windows) {
        entries.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
    }
    entries
}

fn expand_home(entry: &str) -> PathBuf {
    match entry.strip_prefix("~/").or_else(|| entry.strip_prefix("~\\")) {
        Some(rest) => home_dir().join(rest),
        None if entry == "~" => home_dir(),
        None => PathBuf::from(entry),
    }
}

/// The environment of every run: the process's own, the login shell's, a PATH
/// with the settings' and the fallback directories, the settings' variables,
/// and `NO_COLOR` because the output panel shows plain text.
pub fn run_environment(settings: &GuiSettings) -> BTreeMap<String, String> {
    let mut environment: BTreeMap<String, String> = std::env::vars().collect();
    if settings.inherit_shell_environment {
        if let Some(shell) = shell_environment() {
            environment.extend(shell);
        }
    }
    let path_key = environment.keys().find(|key| key.eq_ignore_ascii_case("PATH")).cloned().unwrap_or_else(|| "PATH".into());
    let inherited = environment.get(&path_key).cloned().unwrap_or_default();
    let mut entries: Vec<PathBuf> = settings.extra_path.iter().filter(|entry| !entry.trim().is_empty()).map(|entry| expand_home(entry.trim())).collect();
    entries.extend(std::env::split_paths(&OsString::from(&inherited)));
    entries.extend(fallback_path_entries());
    let mut seen = Vec::new();
    entries.retain(|entry| {
        let keep = !entry.as_os_str().is_empty() && !seen.contains(entry);
        if keep {
            seen.push(entry.clone());
        }
        keep
    });
    if let Ok(path) = std::env::join_paths(&entries) {
        environment.insert(path_key, path.to_string_lossy().into_owned());
    }
    for (name, value) in &settings.environment {
        if !name.trim().is_empty() {
            environment.insert(name.trim().to_string(), value.clone());
        }
    }
    environment.insert("NO_COLOR".into(), "1".into());
    environment
}

fn path_value(environment: &BTreeMap<String, String>) -> String {
    environment.iter().find(|(key, _)| key.eq_ignore_ascii_case("PATH")).map(|(_, value)| value.clone()).unwrap_or_default()
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// The first executable named `program` on the run's PATH (`.cmd`/`.exe` tried on Windows).
pub fn which(program: &str, environment: &BTreeMap<String, String>) -> Option<PathBuf> {
    let candidates: Vec<String> = if cfg!(windows) && Path::new(program).extension().is_none() {
        [".cmd", ".exe", ".bat", ""].iter().map(|suffix| format!("{program}{suffix}")).collect()
    } else {
        vec![program.to_string()]
    };
    std::env::split_paths(&OsString::from(path_value(environment)))
        .flat_map(|directory| candidates.iter().map(move |candidate| directory.join(candidate)))
        .find(|path| is_executable(path))
}

/// How `lz` is launched: the program and the arguments that precede the command.
#[derive(Debug, Clone, PartialEq)]
pub struct Launcher {
    pub program: PathBuf,
    pub prefix: Vec<String>,
}

/// `lzCommand` as the settings name it: a checkout's `main.ts` runs with Bun, a
/// path runs as is, and a bare name is looked up on the run's PATH.
pub fn resolve_launcher(settings: &GuiSettings, environment: &BTreeMap<String, String>) -> Result<Launcher, String> {
    let command = settings.lz_command.trim();
    let command = if command.is_empty() { "lz" } else { command };
    if command.ends_with(".ts") {
        let bun = which("bun", environment).ok_or("lzCommand apunta a un main.ts pero bun no esta en el PATH")?;
        return Ok(Launcher { program: bun, prefix: vec!["run".into(), expand_home(command).to_string_lossy().into_owned()] });
    }
    if command.contains('/') || command.contains('\\') || command.starts_with('~') {
        let path = expand_home(command);
        return if path.is_file() {
            Ok(Launcher { program: path, prefix: Vec::new() })
        } else {
            Err(format!("lzCommand {} no existe", path.display()))
        };
    }
    which(command, environment)
        .map(|program| Launcher { program, prefix: Vec::new() })
        .ok_or_else(|| format!("{command} no esta en el PATH; instala con install.sh --all-global o configura lzCommand"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_output_is_read_between_the_markers() {
        let output = format!("motd noise\n{BEGIN}PATH=/a:/b\0LAZY_WORKFLOW_AZURE_ORGANIZATION=https://dev.azure.com/x\0MULTI=one\ntwo\0{END}trailing");
        let variables = parse_shell_output(&output).unwrap();
        assert_eq!(variables["PATH"], "/a:/b");
        assert_eq!(variables["LAZY_WORKFLOW_AZURE_ORGANIZATION"], "https://dev.azure.com/x");
        assert_eq!(variables["MULTI"], "one\ntwo");
    }

    #[test]
    fn output_without_markers_is_nothing() {
        assert!(parse_shell_output("PATH=/a").is_none());
    }

    #[test]
    fn settings_variables_and_extra_path_reach_the_run() {
        let settings = GuiSettings {
            inherit_shell_environment: false,
            extra_path: vec!["/opt/lz-first".into()],
            environment: BTreeMap::from([("LAZY_WORKFLOW_LOG_FILE".into(), "/tmp/runs.jsonl".into())]),
            ..GuiSettings::default()
        };
        let environment = run_environment(&settings);
        assert_eq!(environment["LAZY_WORKFLOW_LOG_FILE"], "/tmp/runs.jsonl");
        assert_eq!(environment["NO_COLOR"], "1");
        assert!(path_value(&environment).starts_with("/opt/lz-first"));
    }

    #[test]
    fn a_main_ts_runs_with_bun_and_a_missing_path_is_an_error() {
        let settings = GuiSettings { lz_command: "/definitely/missing/lz".into(), inherit_shell_environment: false, ..GuiSettings::default() };
        assert!(resolve_launcher(&settings, &run_environment(&settings)).is_err());
    }
}
