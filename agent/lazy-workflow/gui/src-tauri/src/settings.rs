//! The GUI's own settings: one JSON file the window edits and the `lz` skill
//! documents, so an agent can configure the GUI as reliably as the operator.
//!
//! The file lives at `~/.config/lazy-workflow/gui.json` on every platform — the
//! same home-relative convention the CLI already uses for its run log and its
//! secrets — unless `LAZY_WORKFLOW_GUI_SETTINGS` names another path. It never
//! holds a secret: `secretEnvironment` lists names whose values are read from
//! `lz credentials-get` at the moment a run starts.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const SETTINGS_SCHEMA_VERSION: u32 = 1;
#[cfg(feature = "desktop")]
pub const SETTINGS_PATH_ENV: &str = "LAZY_WORKFLOW_GUI_SETTINGS";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GuiSettings {
    pub schema_version: u32,
    /// `lz` on the PATH, an absolute launcher path, or a checkout's `main.ts` (run with Bun).
    pub lz_command: String,
    /// Read the login shell's environment, so a GUI started from the desktop sees
    /// the PATH and `LAZY_WORKFLOW_*` variables a terminal would.
    pub inherit_shell_environment: bool,
    /// Directories searched before the inherited PATH.
    pub extra_path: Vec<String>,
    /// Variables every run receives, on top of the inherited environment.
    pub environment: BTreeMap<String, String>,
    /// Names resolved with `lz credentials-get --name <NAME> --force` when a run starts.
    pub secret_environment: Vec<String>,
    /// Repositories offered by every working-directory field.
    pub repositories: Vec<String>,
    pub active_repository: Option<String>,
    /// Initial value of a flag in every command that accepts it (`"--cli": "claudecode"`).
    pub flag_defaults: BTreeMap<String, Value>,
    /// Initial values for one command, over `flagDefaults` (`"plan": { "--interview": "http" }`).
    pub command_defaults: BTreeMap<String, BTreeMap<String, Value>>,
    /// Ask before running a command that writes, opens a session, or reinstalls.
    pub confirm_writes: bool,
    /// `system`, `light` or `dark`.
    pub theme: String,
    /// Keys written by a newer GUI or by hand, kept as they are on save.
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Default for GuiSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            lz_command: "lz".into(),
            inherit_shell_environment: true,
            extra_path: Vec::new(),
            environment: BTreeMap::new(),
            secret_environment: Vec::new(),
            repositories: Vec::new(),
            active_repository: None,
            flag_defaults: BTreeMap::new(),
            command_defaults: BTreeMap::new(),
            confirm_writes: true,
            theme: "system".into(),
            extra: BTreeMap::new(),
        }
    }
}

pub fn home_dir() -> PathBuf {
    let from_env = if cfg!(windows) { std::env::var_os("USERPROFILE") } else { std::env::var_os("HOME") };
    from_env.map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(feature = "desktop")]
pub fn settings_path() -> PathBuf {
    match std::env::var_os(SETTINGS_PATH_ENV) {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => home_dir().join(".config").join("lazy-workflow").join("gui.json"),
    }
}

/// A missing file is the defaults; a malformed one is an error, never silently replaced.
pub fn load(path: &Path) -> Result<GuiSettings, String> {
    match fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(GuiSettings::default()),
        Ok(text) => serde_json::from_str(&text).map_err(|error| format!("{} no es JSON valido: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(GuiSettings::default()),
        Err(error) => Err(format!("no se pudo leer {}: {error}", path.display())),
    }
}

/// Written beside the target and renamed over it, so a crash never leaves half a file.
pub fn save(path: &Path, settings: &GuiSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("no se pudo crear {}: {error}", parent.display()))?;
    }
    let mut text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    text.push('\n');
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, text).map_err(|error| format!("no se pudo escribir {}: {error}", temporary.display()))?;
    fs::rename(&temporary, path).map_err(|error| format!("no se pudo reemplazar {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_path(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("lz-gui-settings-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        directory.join("gui.json")
    }

    #[test]
    fn a_missing_file_is_the_defaults() {
        assert_eq!(load(&temporary_path("missing")).unwrap(), GuiSettings::default());
    }

    #[test]
    fn unknown_keys_survive_a_save() {
        let path = temporary_path("extra");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"lzCommand":"/opt/lz","futureKey":{"a":1}}"#).unwrap();
        let settings = load(&path).unwrap();
        assert_eq!(settings.lz_command, "/opt/lz");
        assert!(settings.confirm_writes, "a missing key takes its default");
        save(&path, &settings).unwrap();
        let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["futureKey"]["a"], 1);
        assert_eq!(saved["schemaVersion"], SETTINGS_SCHEMA_VERSION);
    }

    #[test]
    fn a_malformed_file_is_an_error() {
        let path = temporary_path("malformed");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{ not json").unwrap();
        assert!(load(&path).is_err());
    }
}
