use serde::{Deserialize, Serialize};
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};
use url::Url;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
pub enum Authentication {
    #[default]
    Password,
    CloudflareAccess {
        access: super::access::Config,
    },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebConfig {
    pub schema_version: u32,
    pub public_url: String,
    pub listen: SocketAddr,
    pub settings_path: PathBuf,
    pub frontend_dir: PathBuf,
    pub session_seconds: u64,
    pub max_runs: usize,
    pub allowed_commands: Vec<String>,
    #[serde(default)]
    pub authentication: Authentication,
}

impl WebConfig {
    pub fn validate(&self) -> Result<(), String> {
        if let Authentication::CloudflareAccess { access } = &self.authentication {
            access.validate().map_err(|e| e.to_string())?;
        }
        let url =
            Url::parse(&self.public_url).map_err(|_| "publicUrl must be an absolute HTTPS URL")?;
        if self.schema_version != 1
            || url.scheme() != "https"
            || url.host_str().is_none()
            || url.port_or_known_default() != Some(443)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("publicUrl must be https://hostname with no credentials, path, query or nonstandard port; schemaVersion must be 1".into());
        }
        if self.listen.ip() != std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
            || self.listen.port() == 0
        {
            return Err("listen must be 127.0.0.1 with a fixed port".into());
        }
        if !self.settings_path.is_absolute() || !self.frontend_dir.is_absolute() {
            return Err("settingsPath and frontendDir must be absolute server paths".into());
        }
        if !(60..=2_592_000).contains(&self.session_seconds) || !(1..=16).contains(&self.max_runs) {
            return Err("sessionSeconds must be 60..2592000 and maxRuns 1..16".into());
        }
        if self.allowed_commands.is_empty()
            || self.allowed_commands.iter().any(|name| !safe_command(name))
        {
            return Err("allowedCommands must explicitly name workflows/tools; credentials, catalog, gui and update are local-only".into());
        }
        Ok(())
    }
    pub fn origin(&self) -> String {
        Url::parse(&self.public_url)
            .unwrap()
            .origin()
            .ascii_serialization()
    }
    pub fn host(&self) -> String {
        Url::parse(&self.public_url)
            .unwrap()
            .host_str()
            .unwrap()
            .to_string()
    }
}

pub fn safe_command(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
        && !name.starts_with("credentials-")
        && !["gui", "update", "catalog"].contains(&name)
}

pub fn private_write(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path.parent().ok_or("private file needs a parent")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(".write-{}", super::auth::random_token()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        use std::io::Write;
        file.write_all(&serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&temporary, path).map_err(|e| e.to_string())?;
        FileSync::sync(parent)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

struct FileSync;
impl FileSync {
    fn sync(path: &Path) -> Result<(), String> {
        #[cfg(unix)]
        {
            std::fs::File::open(path)
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

pub fn private_directory(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn outside_checkout(path: &Path) -> Result<(), String> {
    let mut existing = path;
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or("private state needs an existing ancestor")?;
    }
    let resolved = existing.canonicalize().map_err(|e| e.to_string())?;
    for directory in resolved.ancestors() {
        let git = directory.join(".git");
        if git.is_file() || git.join("HEAD").is_file() {
            return Err("web credentials and state must live outside every Git checkout".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_state_cannot_be_initialized_inside_a_repository() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap();
        std::fs::write(root.path().join(".git/HEAD"), "ref: refs/heads/main").unwrap();
        let data = root.path().join("private-data");
        assert!(outside_checkout(&data).is_err());
        assert!(!data.exists());
    }
}
