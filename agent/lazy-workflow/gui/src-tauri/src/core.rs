//! Shared machine adapter. Workflow rules remain in `lz`; this module has no Tauri dependency.
use crate::{environment, run_log, runner, settings};
use runner::{Captured, EventSink, RunRequest, RunStarted, Runs};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use settings::GuiSettings;
use std::collections::{BTreeMap, HashMap};
use std::{fs::File, path::PathBuf, sync::Arc, time::Duration};

const CATALOG_SCHEMA_VERSION: u64 = 1;

pub fn installed_commit() -> Option<String> {
    let result = std::process::Command::new("git").args(["rev-parse", "HEAD"])
        .current_dir(settings::home_dir().join(".cache/agent-workflow"))
        .stderr(std::process::Stdio::null()).output().ok()?;
    let sha = String::from_utf8(result.stdout).ok()?.trim().to_string();
    (result.status.success() && sha.len() == 40 && sha.bytes().all(|c| c.is_ascii_hexdigit())).then_some(sha)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDocument {
    pub path: String,
    pub settings: GuiSettings,
    pub error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentProbe {
    pub name: String,
    pub secret: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbedVariable {
    pub name: String,
    pub present: bool,
    pub value: Option<String>,
    pub source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbedBinary {
    pub name: String,
    pub path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub settings_path: String,
    pub run_log_path: String,
    pub lz_launcher: Option<String>,
    pub lz_error: Option<String>,
    pub credentials_error: Option<String>,
    pub shell_environment: bool,
    pub binaries: Vec<ProbedBinary>,
    pub variables: Vec<ProbedVariable>,
}

const PROBED_BINARIES: [&str; 9] = [
    "lz", "bun", "git", "gh", "az", "opencode", "claude", "codex", "chezmoi",
];

/// A secret-looking name remains private even if a caller labels it public.
pub fn is_secret_name(name: &str) -> bool {
    name.to_ascii_uppercase().split('_').any(|word| {
        [
            "TOKEN",
            "PASSWORD",
            "PASSWD",
            "PASSPHRASE",
            "SECRET",
            "APIKEY",
            "KEY",
            "CREDENTIAL",
            "CREDENTIALS",
            "AUTH",
            "PAT",
        ]
        .contains(&word)
    })
}

fn configured_run_log_path(
    environment: &BTreeMap<String, String>,
    statuses: &[ProbedVariable],
) -> PathBuf {
    let mut environment = environment.clone();
    if !environment
        .get("LAZY_WORKFLOW_LOG_FILE")
        .is_some_and(|value| !value.is_empty())
    {
        if let Some(value) = statuses
            .iter()
            .find(|status| status.name == "LAZY_WORKFLOW_LOG_FILE")
            .and_then(|status| status.value.as_ref())
        {
            environment.insert("LAZY_WORKFLOW_LOG_FILE".into(), value.clone());
        }
    }
    run_log::run_log_path(&environment)
}

#[derive(Clone)]
pub struct Core {
    pub settings_path: PathBuf,
    pub runs: Runs,
    // The OS releases this lease on exit, including a crash. Never unlink the lock file.
    _lease: Arc<File>,
}

pub fn acquire_profile_lease(path: PathBuf) -> Result<File, String> {
    let parent = path.parent().ok_or("lease needs a parent")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lease = options.open(path).map_err(|error| error.to_string())?;
    fs2::FileExt::try_lock_exclusive(&lease).map_err(|_| {
        "this profile or installation is already open; stop its desktop or web instance first"
            .to_string()
    })?;
    Ok(lease)
}

impl Core {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        let parent = path.parent().ok_or("settings need a parent directory")?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let path = if path.exists() {
            path.canonicalize().map_err(|error| error.to_string())?
        } else {
            parent
                .canonicalize()
                .map_err(|error| error.to_string())?
                .join(path.file_name().ok_or("settings need a filename")?)
        };
        let lease = Arc::new(acquire_profile_lease(path.with_extension("profile.lock"))?);
        Ok(Self {
            settings_path: path,
            runs: Runs::with_profile_lease(lease.clone()),
            _lease: lease,
        })
    }

    pub fn settings(&self) -> Result<GuiSettings, String> {
        settings::load(&self.settings_path)
    }

    pub fn get_settings(&self) -> SettingsDocument {
        let (settings, error) = match self.settings() {
            Ok(settings) => (settings, None),
            Err(error) => (GuiSettings::default(), Some(error)),
        };
        SettingsDocument {
            path: self.settings_path.to_string_lossy().into_owned(),
            settings,
            error,
        }
    }

    pub fn save_settings(&self, settings: GuiSettings) -> Result<SettingsDocument, String> {
        settings::save(&self.settings_path, &settings)?;
        environment::reload_shell_environment();
        Ok(self.get_settings())
    }

    pub fn load_catalog(&self) -> Result<Value, String> {
        let captured = self.capture(&["catalog".to_string()], Duration::from_secs(60))?;
        if captured.code != Some(0) {
            return Err(format!("`lz catalog` fallo (codigo {}): {}. Si tu lz es anterior a la GUI, ejecuta `lz update`.", captured.code.map_or("?".into(), |code| code.to_string()), captured.stderr.trim()));
        }
        let catalog: Value = serde_json::from_str(&captured.stdout)
            .map_err(|error| format!("`lz catalog` no imprimio JSON valido: {error}"))?;
        match catalog.get("schemaVersion").and_then(Value::as_u64) {
            Some(CATALOG_SCHEMA_VERSION) => Ok(catalog),
            other => Err(format!("el catalogo de lz usa el esquema {other:?}; esta GUI entiende el {CATALOG_SCHEMA_VERSION}: actualiza la GUI")),
        }
    }

    pub fn start(&self, events: EventSink, request: RunRequest) -> Result<RunStarted, String> {
        self.runs.start(events, &self.settings()?, request)
    }

    pub fn read_run_log(&self, limit: usize) -> Result<run_log::RunLog, String> {
        let environment = environment::run_environment(&self.settings()?);
        let statuses = if environment
            .get("LAZY_WORKFLOW_LOG_FILE")
            .is_some_and(|value| !value.is_empty())
        {
            Vec::new()
        } else {
            self.credential_statuses().unwrap_or_default()
        };
        let path = configured_run_log_path(&environment, &statuses);
        run_log::read(&path, limit)
    }

    pub fn capture(&self, args: &[String], timeout: Duration) -> Result<Captured, String> {
        runner::capture(&self.settings()?, args, timeout)
    }

    fn credential_statuses(&self) -> Result<Vec<ProbedVariable>, String> {
        // One CLI read shares its store, parsing and precedence; Rust never decodes secret files.
        let captured = self.capture(
            &["credentials-status".into(), "--no-log-file".into()],
            Duration::from_secs(30),
        )?;
        if captured.code != Some(0) {
            return Err(
                "No se pudo consultar el almacen de credenciales; actualiza lz y vuelve a cargar."
                    .into(),
            );
        }
        serde_json::from_str(&captured.stdout)
            .map_err(|_| "lz credentials-status no devolvio un estado valido; actualiza lz.".into())
    }

    pub fn diagnose(&self, variables: Vec<EnvironmentProbe>) -> Result<Diagnostics, String> {
        let settings = self.settings()?;
        let run_environment = environment::run_environment(&settings);
        let lz = environment::resolve_launcher(&settings, &run_environment).map(|launcher| {
            std::iter::once(launcher.program.to_string_lossy().into_owned())
                .chain(launcher.prefix)
                .collect::<Vec<_>>()
                .join(" ")
        });
        let statuses = self.credential_statuses();
        let credentials_error = statuses.as_ref().err().cloned();
        let statuses = statuses.unwrap_or_default();
        let run_log_path = configured_run_log_path(&run_environment, &statuses);
        let stored: HashMap<_, _> = statuses
            .into_iter()
            .map(|status| (status.name.clone(), status))
            .collect();
        Ok(Diagnostics {
            settings_path: self.settings_path.to_string_lossy().into_owned(),
            run_log_path: run_log_path.to_string_lossy().into_owned(),
            lz_launcher: lz.as_ref().ok().cloned(),
            lz_error: lz.err(),
            credentials_error,
            shell_environment: settings.inherit_shell_environment
                && environment::shell_environment().is_some(),
            binaries: PROBED_BINARIES
                .iter()
                .map(|name| ProbedBinary {
                    name: name.to_string(),
                    path: environment::which(name, &run_environment)
                        .map(|path| path.to_string_lossy().into_owned()),
                })
                .collect(),
            variables: variables
                .into_iter()
                .map(|probe| {
                    let private = probe.secret
                        || is_secret_name(&probe.name)
                        || settings
                            .secret_environment
                            .iter()
                            .any(|name| name == &probe.name);
                    let value = run_environment
                        .get(&probe.name)
                        .filter(|value| !value.is_empty());
                    let status = stored.get(&probe.name);
                    ProbedVariable {
                        present: value.is_some() || status.is_some_and(|status| status.present),
                        value: if private {
                            None
                        } else {
                            value
                                .cloned()
                                .or_else(|| status.and_then(|status| status.value.clone()))
                        },
                        source: if value.is_some() {
                            if settings.environment.contains_key(&probe.name) {
                                "settings"
                            } else {
                                "environment"
                            }
                        } else {
                            status.map_or("missing", |status| status.source.as_str())
                        }
                        .into(),
                        name: probe.name,
                    }
                })
                .collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_uses_the_stored_log_path_unless_the_profile_overrides_it() {
        let statuses = vec![ProbedVariable {
            name: "LAZY_WORKFLOW_LOG_FILE".into(),
            present: true,
            value: Some("/synthetic/stored.jsonl".into()),
            source: "credentials".into(),
        }];
        assert_eq!(
            configured_run_log_path(&BTreeMap::new(), &statuses),
            PathBuf::from("/synthetic/stored.jsonl")
        );
        let environment = BTreeMap::from([(
            "LAZY_WORKFLOW_LOG_FILE".into(),
            "/synthetic/profile.jsonl".into(),
        )]);
        assert_eq!(
            configured_run_log_path(&environment, &statuses),
            PathBuf::from("/synthetic/profile.jsonl")
        );
    }

    #[test]
    fn desktop_and_web_cannot_open_the_same_profile_twice() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("gui.json");
        let first = Core::open(path.clone()).unwrap();
        assert!(Core::open(path.clone()).is_err());
        drop(first);
        // Parallel test children can briefly inherit a CLOEXEC lease before exec.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while Core::open(path.clone()).is_err() {
            assert!(
                std::time::Instant::now() < deadline,
                "profile lease survived owner exit"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}
