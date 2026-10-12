//! Authorization narrows the catalog; the CLI still performs its domain validation.
use super::config::{safe_command, WebConfig};
use crate::{
    runner::RunRequest,
    settings::{home_dir, GuiSettings},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

fn allowed_flag(flag: &Value) -> bool {
    flag["kind"] != "secret"
        && flag["forwarded"] != true
        && ![
            "--off",
            "--off-delay",
            "--log-file",
            "--no-log-file",
            "--interview-host",
            "--interview-port",
            "--verbose-output",
        ]
        .contains(&flag["flag"].as_str().unwrap_or(""))
}

fn forbidden_name(name: &str) -> bool {
    [
        "--off",
        "--off-delay",
        "--log-file",
        "--no-log-file",
        "--interview-host",
        "--interview-port",
        "--verbose-output",
    ]
    .contains(&name)
}

pub fn catalog(mut catalog: Value, config: &WebConfig) -> Result<Value, String> {
    let commands = catalog["commands"]
        .as_array_mut()
        .ok_or("catalog needs commands")?;
    for name in &config.allowed_commands {
        if !commands
            .iter()
            .any(|command| command["name"] == *name && command["effect"] != "maintenance")
        {
            return Err(format!(
                "allowed command {name} does not exist in this lz catalog"
            ));
        }
    }
    commands.retain(|command| {
        command["name"].as_str().is_some_and(|name| {
            safe_command(name)
                && config
                    .allowed_commands
                    .iter()
                    .any(|allowed| allowed == name)
        })
    });
    for command in commands {
        if let Some(flags) = command["flags"].as_array_mut() {
            flags.retain(allowed_flag);
        }
        if let Some(groups) = command["groups"].as_array_mut() {
            groups.retain(|group| group != "shutdown");
        }
    }
    if let Some(groups) = catalog["groups"].as_array_mut() {
        groups.retain(|group| group["id"] != "shutdown");
        for group in groups {
            if let Some(flags) = group["flags"].as_array_mut() {
                flags.retain(allowed_flag);
            }
        }
    }
    Ok(catalog)
}

pub fn public_settings(mut settings: GuiSettings) -> GuiSettings {
    settings.environment.clear();
    settings.extra.clear();
    settings
        .flag_defaults
        .retain(|flag, _| !forbidden_name(flag));
    settings
        .command_defaults
        .retain(|command, _| safe_command(command));
    for defaults in settings.command_defaults.values_mut() {
        defaults.retain(|flag, _| !forbidden_name(flag));
    }
    settings
}

pub fn preferences(current: &GuiSettings, next: GuiSettings) -> Result<GuiSettings, String> {
    let visible = public_settings(current.clone());
    if next.schema_version != visible.schema_version
        || next.lz_command != visible.lz_command
        || next.inherit_shell_environment != visible.inherit_shell_environment
        || next.extra_path != visible.extra_path
        || next.environment != visible.environment
        || next.secret_environment != visible.secret_environment
        || next.repositories != visible.repositories
        || !next.extra.is_empty()
    {
        return Err(
            "launcher, environment, secrets and repositories are configured locally on the server"
                .into(),
        );
    }
    if !["system", "light", "dark"].contains(&next.theme.as_str())
        || next
            .active_repository
            .as_ref()
            .is_some_and(|repo| !current.repositories.contains(repo))
    {
        return Err("invalid theme or unregistered active repository".into());
    }
    if next.flag_defaults.len() > 128 || next.command_defaults.len() > 128 {
        return Err("too many defaults".into());
    }
    if next.flag_defaults.keys().any(|name| forbidden_name(name))
        || next.command_defaults.iter().any(|(command, flags)| {
            !safe_command(command) || flags.keys().any(|name| forbidden_name(name))
        })
    {
        return Err("local-only defaults cannot be changed in the browser".into());
    }
    let mut settings = current.clone();
    settings.theme = next.theme;
    settings.confirm_writes = next.confirm_writes;
    settings.active_repository = next.active_repository;
    settings.flag_defaults = next.flag_defaults;
    settings.command_defaults = next.command_defaults;
    for (flag, value) in &current.flag_defaults {
        if !visible.flag_defaults.contains_key(flag) {
            settings.flag_defaults.insert(flag.clone(), value.clone());
        }
    }
    for (command, flags) in &current.command_defaults {
        if !visible.command_defaults.contains_key(command) {
            settings
                .command_defaults
                .insert(command.clone(), flags.clone());
        } else {
            for (flag, value) in flags {
                if forbidden_name(flag) {
                    settings
                        .command_defaults
                        .entry(command.clone())
                        .or_default()
                        .insert(flag.clone(), value.clone());
                }
            }
        }
    }
    Ok(settings)
}

fn registered(path: &str, settings: &GuiSettings) -> Result<PathBuf, String> {
    let path = Path::new(path)
        .canonicalize()
        .map_err(|_| "server repository does not exist")?;
    if !path.is_dir()
        || !settings
            .repositories
            .iter()
            .any(|repo| Path::new(repo).canonicalize().ok().as_ref() == Some(&path))
    {
        return Err("repository is not registered in this server profile".into());
    }
    Ok(path)
}

const NO_BROWSING: &str =
    "this server registers repositories locally; its owner can set repositoryRoots in web.json";
const MAX_FOLDERS: usize = 500;

fn canonical_roots(roots: &[PathBuf]) -> Vec<PathBuf> {
    roots
        .iter()
        .filter(|root| root.is_absolute())
        .filter_map(|root| root.canonicalize().ok())
        .collect()
}

/// Below a configured root, outside hidden folders and the server's private state.
fn browsable(path: &Path, roots: &[PathBuf], private: &Path) -> bool {
    path.is_dir()
        && !path.starts_with(private)
        && roots.iter().any(|root| {
            path.strip_prefix(root).is_ok_and(|inside| {
                inside
                    .components()
                    .all(|part| !part.as_os_str().to_string_lossy().starts_with('.'))
            })
        })
}

fn browsable_path(path: &str, roots: &[PathBuf], private: &Path) -> Result<PathBuf, String> {
    if path.len() > 4096 || path.contains('\0') {
        return Err("invalid server path".into());
    }
    let expanded = match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            home_dir().join(rest.trim_start_matches('/'))
        }
        _ => PathBuf::from(path),
    };
    if !expanded.is_absolute() {
        return Err("write an absolute server path or one starting with ~".into());
    }
    let path = expanded
        .canonicalize()
        .map_err(|_| "server folder does not exist")?;
    if !browsable(&path, roots, private) {
        return Err("this server folder cannot be browsed from the browser".into());
    }
    Ok(path)
}

/// One level of server folders, so a phone can walk to a repository instead of typing its path.
pub fn folders(
    path: Option<&str>,
    roots: &[PathBuf],
    private: &Path,
    settings: &GuiSettings,
) -> Result<Value, String> {
    let roots = canonical_roots(roots);
    let first = roots
        .first()
        .ok_or(NO_BROWSING)?
        .to_string_lossy()
        .into_owned();
    let path = browsable_path(path.unwrap_or(&first), &roots, private)?;
    let registered: Vec<PathBuf> = settings
        .repositories
        .iter()
        .filter_map(|repo| Path::new(repo).canonicalize().ok())
        .collect();
    let mut entries: Vec<(String, PathBuf)> = std::fs::read_dir(&path)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let target = entry.path().canonicalize().ok()?;
            target.to_str()?;
            browsable(&target, &roots, private)
                .then_some((entry.file_name().into_string().ok()?, target))
        })
        .collect();
    entries.sort_by_key(|(name, _)| name.to_lowercase());
    let truncated = entries.len() > MAX_FOLDERS;
    entries.truncate(MAX_FOLDERS);
    let home = home_dir();
    Ok(json!({
        "path": path.to_str().ok_or("server path is not UTF-8")?,
        "parent": path.parent().filter(|parent| browsable(parent, &roots, private)).and_then(Path::to_str),
        "home": home.canonicalize().unwrap_or(home).to_str(),
        "truncated": truncated,
        "entries": entries.iter().map(|(name, target)| json!({
            "name": name,
            "path": target.to_str(),
            "repository": target.join(".git").exists(),
            "registered": registered.contains(target),
        })).collect::<Vec<_>>(),
    }))
}

/// Registers a browsable folder, or selects it when it is already registered.
pub fn register(
    path: &str,
    roots: &[PathBuf],
    private: &Path,
    mut settings: GuiSettings,
) -> Result<GuiSettings, String> {
    let roots = canonical_roots(roots);
    if roots.is_empty() {
        return Err(NO_BROWSING.into());
    }
    let path = browsable_path(path, &roots, private)?;
    let existing = settings
        .repositories
        .iter()
        .find(|repo| Path::new(repo).canonicalize().ok().as_ref() == Some(&path))
        .cloned();
    let repository = match existing {
        Some(repository) => repository,
        None => {
            let added = path.to_str().ok_or("server path is not UTF-8")?.to_string();
            settings.repositories.push(added.clone());
            added
        }
    };
    settings.active_repository = Some(repository);
    Ok(settings)
}

fn validate_value(
    flag: &Value,
    value: &str,
    settings: &GuiSettings,
    uploads: &Path,
) -> Result<(), String> {
    if value.len() > 32768 || value.contains('\0') {
        return Err("invalid or oversized argument".into());
    }
    match flag["kind"].as_str().unwrap_or("") {
        "directory" => {
            registered(value, settings)?;
        }
        "directories" => {
            if value.split(',').count() > 16 {
                return Err("too many repositories".into());
            }
            for repo in value.split(',') {
                registered(repo.trim(), settings)?;
            }
        }
        "file" => {
            let file = Path::new(value)
                .canonicalize()
                .map_err(|_| "server file does not exist")?;
            let allowed = settings
                .repositories
                .iter()
                .filter_map(|repo| Path::new(repo).canonicalize().ok())
                .any(|repo| file.starts_with(repo))
                || uploads
                    .canonicalize()
                    .ok()
                    .is_some_and(|root| file.starts_with(root));
            if !file.is_file() || !allowed {
                return Err(
                    "file must be inside a registered server repository or an uploaded text file"
                        .into(),
                );
            }
        }
        "integer" => {
            value
                .parse::<i64>()
                .map_err(|_| "argument must be an integer")?;
        }
        "number" => {
            if !value
                .parse::<f64>()
                .map_err(|_| "argument must be a number")?
                .is_finite()
            {
                return Err("argument must be finite".into());
            }
        }
        "choice"
            if !flag["choices"]
                .as_array()
                .is_some_and(|choices| choices.iter().any(|choice| choice == value)) =>
        {
            return Err("argument is not an allowed choice".into());
        }
        _ => {}
    }
    Ok(())
}

pub fn validate(
    request: &mut RunRequest,
    catalog: &Value,
    settings: &GuiSettings,
    uploads: &Path,
) -> Result<(), String> {
    if request.stdin.is_some() || request.args.is_empty() || request.args.len() > 128 {
        return Err("web runs require 1..128 arguments and accept no raw stdin".into());
    }
    let command = catalog["commands"]
        .as_array()
        .and_then(|commands| {
            commands
                .iter()
                .find(|command| command["name"] == request.args[0])
        })
        .ok_or("operation is not permitted by this server")?;
    let mut flags: Vec<&Value> = command["flags"]
        .as_array()
        .ok_or("catalog needs flags")?
        .iter()
        .collect();
    for group in catalog["groups"].as_array().ok_or("catalog needs groups")? {
        if command["groups"]
            .as_array()
            .is_some_and(|groups| groups.contains(&group["id"]))
        {
            flags.extend(group["flags"].as_array().ok_or("group needs flags")?);
        }
    }
    let mut seen = BTreeSet::new();
    let mut index = 1;
    while index < request.args.len() {
        let name = &request.args[index];
        let flag = flags.iter().find(|flag| flag["flag"] == *name).ok_or(
            "unknown or forbidden flag; use the catalog's long flags as separate arguments",
        )?;
        if !seen.insert(name.clone()) && flag["repeatable"] != true {
            return Err("duplicate flag".into());
        }
        if flag["kind"] != "boolean" {
            index += 1;
            let value = request.args.get(index).ok_or("flag needs a value")?;
            validate_value(flag, value, settings, uploads)?;
        }
        index += 1;
    }
    let cwd = request
        .cwd
        .as_ref()
        .or(settings.active_repository.as_ref())
        .ok_or("select a registered server repository")?;
    request.cwd = Some(registered(cwd, settings)?.to_string_lossy().into_owned());
    if request.args[0] == "plan"
        && request
            .args
            .windows(2)
            .any(|args| args[0] == "--interview" && args[1] == "http")
    {
        // The private question server always binds to an ephemeral loopback port.
        request.args.extend([
            "--interview-host".into(),
            "127.0.0.1".into(),
            "--interview-port".into(),
            "0".into(),
        ]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_alias_flags_and_unlisted_operations_cannot_escape_the_profile() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let settings = GuiSettings {
            repositories: vec![root.path().to_string_lossy().into_owned()],
            active_repository: Some(root.path().to_string_lossy().into_owned()),
            ..GuiSettings::default()
        };
        let catalog = serde_json::json!({"commands":[{"name":"code","groups":[],"flags":[{"flag":"--working-directory","kind":"directory"}]}],"groups":[]});
        for args in [
            vec!["credentials-get"],
            vec!["code", "--off"],
            vec!["code", "-C", "/"],
            vec!["code", "--working-directory=/"],
        ] {
            let mut request = RunRequest {
                args: args.into_iter().map(String::from).collect(),
                cwd: None,
                stdin: None,
            };
            assert!(validate(&mut request, &catalog, &settings, root.path()).is_err());
        }
        let mut request = RunRequest {
            args: vec!["code".into()],
            cwd: Some(outside.path().to_string_lossy().into_owned()),
            stdin: None,
        };
        assert!(validate(&mut request, &catalog, &settings, root.path()).is_err());
        request.cwd = None;
        assert!(validate(&mut request, &catalog, &settings, root.path()).is_ok());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
            request.cwd = Some(root.path().join("escape").to_string_lossy().into_owned());
            assert!(validate(&mut request, &catalog, &settings, root.path()).is_err());
        }
    }

    #[test]
    fn the_browser_walks_and_registers_only_visible_folders_below_its_roots() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        for folder in ["Beta/.git", "alpha", ".config", "private/uploads"] {
            std::fs::create_dir_all(base.join(folder)).unwrap();
        }
        std::fs::write(base.join("notes.txt"), "not a folder").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), base.join("escape")).unwrap();
        let roots = [root.path().to_path_buf()];
        let private = base.join("private");
        let settings = GuiSettings {
            repositories: vec![format!("{}/alpha/", base.display())],
            ..GuiSettings::default()
        };

        let listing = folders(None, &roots, &private, &settings).unwrap();
        assert_eq!(listing["path"], json!(base));
        assert!(listing["parent"].is_null());
        assert_eq!(
            listing["entries"],
            json!([
                {"name":"alpha","path":base.join("alpha"),"repository":false,"registered":true},
                {"name":"Beta","path":base.join("Beta"),"repository":true,"registered":false},
            ])
        );
        let inner = folders(
            Some(base.join("Beta").to_str().unwrap()),
            &roots,
            &private,
            &settings,
        )
        .unwrap();
        assert_eq!(inner["parent"], json!(base));
        assert_eq!(inner["entries"], json!([]));

        let escapes = [
            base.join("Beta/../..").display().to_string(),
            outside.path().display().to_string(),
            base.join("escape").display().to_string(),
            base.join(".config").display().to_string(),
            private.display().to_string(),
            base.join("notes.txt").display().to_string(),
            "relative/path".into(),
        ];
        for path in &escapes {
            assert!(
                folders(Some(path), &roots, &private, &settings).is_err(),
                "{path}"
            );
            assert!(
                register(path, &roots, &private, settings.clone()).is_err(),
                "{path}"
            );
        }
        assert!(folders(None, &[], &private, &settings).is_err());
        assert!(register(base.to_str().unwrap(), &[], &private, settings.clone()).is_err());

        let added = register(
            base.join("Beta").to_str().unwrap(),
            &roots,
            &private,
            settings.clone(),
        )
        .unwrap();
        assert_eq!(added.repositories[1], base.join("Beta").to_str().unwrap());
        assert_eq!(
            added.active_repository.as_deref(),
            Some(added.repositories[1].as_str())
        );
        let again = register(
            base.join("alpha").to_str().unwrap(),
            &roots,
            &private,
            added,
        )
        .unwrap();
        assert_eq!(again.repositories.len(), 2);
        assert_eq!(
            again.active_repository,
            Some(settings.repositories[0].clone())
        );
    }
}
