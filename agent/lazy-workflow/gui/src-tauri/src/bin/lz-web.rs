use lz_gui_lib::{
    core::Core,
    web::{
        self,
        auth::{AccessRevocations, Owner, Sessions},
        config::{private_write, Authentication, WebConfig},
    },
};
use std::{collections::BTreeMap, path::PathBuf, sync::atomic::Ordering};

const HELP: &str = "\
Usage: lz-web <command> [options]

Commands (all administration is local to the server):
  init             Create a new installation; never overwrite existing data.
  serve            Run the backend with its existing configuration.
  use-access       Migrate to Cloudflare Access; revoke sessions and rebind the owner.
  bind-access      Bind the verified GitHub owner from identity JSON on stdin.
  unbind-access    Remove the owner binding and revoke sessions.
  revoke-sessions  Revoke local sessions and Access assertions.
  set-password     Change the password in password mode only.

Options:
  --data-dir <path>       Absolute private installation directory (required).
  --public-url <https>   Public HTTPS origin (init).
  --settings <path>      Absolute gui.json profile path (init).
  --frontend <path>      Absolute built frontend directory (init).
  --access-config <path> Access configuration JSON (init or use-access).
  --listen <address>     Loopback address, default 127.0.0.1:8234 (init).
  --owner <name>         Password-mode owner, default owner (init).
  --password-stdin      Read a password from stdin (init or set-password).
  -h, --help            Show this help without opening or changing a profile.

Access initialization takes no password. bind-access, unbind-access, use-access,
revoke-sessions and set-password require the backend stopped. After binding or
local revocation, log out of Access and authenticate again. Keep one process per
profile; each owner runs an independent installation on their own server.

lz gui opens the desktop app. Web setup and service updates are separate from
lz update. Build and install lz-web using the guides:
https://github.com/elvisbrevi/agent-workflow/blob/main/agent/lazy-workflow/gui/WEB.md
https://github.com/elvisbrevi/agent-workflow/blob/main/agent/lazy-workflow/gui/ACCESS.md
";

fn arguments() -> Result<(String, BTreeMap<String, String>), String> {
    let mut args = std::env::args().skip(1);
    let action = args.next().ok_or(
        "usage: lz-web init|serve|use-access|bind-access|unbind-access|set-password|revoke-sessions --data-dir <absolute-path>",
    )?;
    if ![
        "init",
        "serve",
        "use-access",
        "bind-access",
        "unbind-access",
        "set-password",
        "revoke-sessions",
    ]
    .contains(&action.as_str())
    {
        return Err("unknown action".into());
    }
    let mut options = BTreeMap::new();
    while let Some(flag) = args.next() {
        if action != "init"
            && flag != "--data-dir"
            && !(action == "set-password" && flag == "--password-stdin")
            && !(action == "use-access" && flag == "--access-config")
        {
            return Err(format!("{flag} is not accepted by {action}"));
        }
        if ![
            "--data-dir",
            "--public-url",
            "--listen",
            "--settings",
            "--frontend",
            "--owner",
            "--password-stdin",
            "--access-config",
        ]
        .contains(&flag.as_str())
        {
            return Err(format!("unknown option {flag}"));
        }
        let value = if flag == "--password-stdin" {
            "true".into()
        } else {
            args.next()
                .ok_or_else(|| format!("{flag} requires a value"))?
        };
        if options.insert(flag.clone(), value).is_some() {
            return Err(format!("duplicate option {flag}"));
        }
    }
    Ok((action, options))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccessSetup {
    public_url: String,
    access: web::access::Config,
}
fn access_setup(
    options: &BTreeMap<String, String>,
    public_url: &str,
) -> Result<Authentication, String> {
    let path = PathBuf::from(required(options, "--access-config")?);
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > 65536 {
        return Err("Access configuration is too large".into());
    }
    let setup: AccessSetup = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if setup.public_url.trim_end_matches('/') != public_url.trim_end_matches('/') {
        return Err("Access configuration belongs to another public origin".into());
    }
    setup.access.validate().map_err(|e| e.to_string())?;
    Ok(Authentication::CloudflareAccess {
        access: setup.access,
    })
}
fn required(options: &BTreeMap<String, String>, name: &str) -> Result<String, String> {
    options
        .get(name)
        .cloned()
        .ok_or_else(|| format!("{name} is required"))
}
fn password(options: &BTreeMap<String, String>) -> Result<String, String> {
    if options.contains_key("--password-stdin") {
        use std::io::Read;
        let mut password = String::new();
        std::io::stdin()
            .take(1026)
            .read_to_string(&mut password)
            .map_err(|e| e.to_string())?;
        Ok(password.trim_end_matches(['\r', '\n']).to_string())
    } else {
        rpassword::prompt_password("Owner password (12+ characters): ").map_err(|e| e.to_string())
    }
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("lz-web: {error}");
        std::process::exit(1);
    }
}
async fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.is_empty()
        || args.first().is_some_and(|arg| arg == "help")
        || args.iter().any(|arg| arg == "--help" || arg == "-h")
    {
        print!("{HELP}");
        return Ok(());
    }
    let (action, options) = arguments()?;
    let data_dir = PathBuf::from(required(&options, "--data-dir")?);
    if !data_dir.is_absolute() {
        return Err("--data-dir must be an absolute server path".into());
    }
    if action == "init" {
        let public_url = required(&options, "--public-url")?;
        let authentication = if options.contains_key("--access-config") {
            if options.contains_key("--owner") || options.contains_key("--password-stdin") {
                return Err("Access initialization takes no password or username".into());
            }
            access_setup(&options, &public_url)?
        } else {
            Authentication::Password
        };
        let config = WebConfig {
            schema_version: 1,
            public_url,
            authentication,
            listen: options
                .get("--listen")
                .map(String::as_str)
                .unwrap_or("127.0.0.1:8234")
                .parse()
                .map_err(|_| "invalid listen address")?,
            settings_path: PathBuf::from(required(&options, "--settings")?),
            frontend_dir: PathBuf::from(required(&options, "--frontend")?),
            session_seconds: 43200,
            max_runs: 1,
            allowed_commands: [
                "plan",
                "code",
                "git-branch-list",
                "git-branch-checkout",
                "pr-list",
                "pr-info",
                "pr-thread-list",
                "pr-thread-reply",
                "pr-create",
                "github-auth-info",
                "github-repo-info",
                "github-issue-list",
                "github-issue-info",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
        };
        config.validate()?;
        if data_dir.join("web.json").exists() || data_dir.join("owner.json").exists() {
            return Err("installation already initialized".into());
        }
        let owner = if matches!(config.authentication, Authentication::Password) {
            Some(Owner::create(
                options.get("--owner").cloned().unwrap_or("owner".into()),
                &password(&options)?,
            )?)
        } else {
            None
        };
        web::initialize(&data_dir, &config, owner.as_ref())?;
        println!(
            "Initialized HTTPS configuration in {}. No DNS or connector has been changed.",
            data_dir.display()
        );
        return Ok(());
    }
    let mut config = web::load_config(&data_dir)?;
    if action != "serve" {
        let _instance =
            lz_gui_lib::core::acquire_profile_lease(data_dir.join("web.instance.lock"))?;
        let _lease = Core::open(config.settings_path.clone())?;
        if action == "set-password" {
            if !matches!(config.authentication, Authentication::Password) {
                return Err("password authentication is disabled in Access mode".into());
            }
            let current: Owner = serde_json::from_slice(
                &std::fs::read(data_dir.join("owner.json")).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let owner = Owner::create(current.username, &password(&options)?)?;
            private_write(&data_dir.join("owner.json"), &owner)?;
        }
        if action == "use-access" {
            config.authentication = access_setup(&options, &config.public_url)?;
        }
        if action == "bind-access" || action == "unbind-access" {
            let Authentication::CloudflareAccess { access } = &mut config.authentication else {
                return Err("configure Cloudflare Access first".into());
            };
            access.owner_subject = if action == "bind-access" {
                use std::io::Read;
                let mut bytes = Vec::new();
                std::io::stdin()
                    .take(65537)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                if bytes.len() > 65536 {
                    return Err("identity response is too large".into());
                }
                let identity: web::access::Identity =
                    serde_json::from_slice(&bytes).map_err(|_| "invalid verified identity JSON")?;
                Some(
                    identity
                        .binding(access)
                        .map_err(|e| e.to_string())?
                        .provider_user_id,
                )
            } else {
                None
            };
        }
        config.validate()?;
        Sessions::revoke_all(&data_dir.join("sessions.json"))?;
        if matches!(
            config.authentication,
            Authentication::CloudflareAccess { .. }
        ) {
            AccessRevocations::revoke_all(&data_dir.join("access-revocations.json"))?;
        }
        private_write(&data_dir.join("web.json"), &config)?;
        println!("Sessions revoked. Restart the backend service.");
        return Ok(());
    }
    let state = web::WebState::open(config, data_dir)?;
    let listener = tokio::net::TcpListener::bind(state.config.listen)
        .await
        .map_err(|e| e.to_string())?;
    println!(
        "lz-web listening on {}; public origin {}",
        state.config.listen,
        state.config.origin()
    );
    let shutdown = state.clone();
    axum::serve(listener, web::router(state))
        .with_graceful_shutdown(async move {
            #[cfg(unix)]
            {
                let mut term =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .expect("SIGTERM handler");
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
            shutdown.stopping.store(true, Ordering::SeqCst);
            let _ = tokio::task::spawn_blocking(move || shutdown.core.runs.shutdown()).await;
        })
        .await
        .map_err(|e| e.to_string())
}
