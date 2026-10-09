use lz_gui_lib::{
    core::Core,
    web::{
        self,
        auth::{Owner, Sessions},
        config::{private_write, WebConfig},
    },
};
use std::{collections::BTreeMap, path::PathBuf, sync::atomic::Ordering};

fn arguments() -> Result<(String, BTreeMap<String, String>), String> {
    let mut args = std::env::args().skip(1);
    let action = args.next().ok_or(
        "usage: lz-web init|serve|set-password|revoke-sessions --data-dir <absolute-path>",
    )?;
    if !["init", "serve", "set-password", "revoke-sessions"].contains(&action.as_str()) {
        return Err("unknown action".into());
    }
    let mut options = BTreeMap::new();
    while let Some(flag) = args.next() {
        if action != "init"
            && flag != "--data-dir"
            && !(action == "set-password" && flag == "--password-stdin")
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
    let (action, options) = arguments()?;
    let data_dir = PathBuf::from(required(&options, "--data-dir")?);
    if !data_dir.is_absolute() {
        return Err("--data-dir must be an absolute server path".into());
    }
    if action == "init" {
        let config = WebConfig {
            schema_version: 1,
            public_url: required(&options, "--public-url")?,
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
                "review",
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
        let owner = Owner::create(
            options.get("--owner").cloned().unwrap_or("owner".into()),
            &password(&options)?,
        )?;
        web::initialize(&data_dir, &config, &owner)?;
        println!("Initialized owner and HTTPS configuration in {}. No DNS or connector has been changed.", data_dir.display());
        return Ok(());
    }
    let config = web::load_config(&data_dir)?;
    if action == "set-password" || action == "revoke-sessions" {
        let _instance =
            lz_gui_lib::core::acquire_profile_lease(data_dir.join("web.instance.lock"))?;
        let _lease = Core::open(config.settings_path.clone())?;
        if action == "set-password" {
            let current: Owner = serde_json::from_slice(
                &std::fs::read(data_dir.join("owner.json")).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let owner = Owner::create(current.username, &password(&options)?)?;
            private_write(&data_dir.join("owner.json"), &owner)?;
        }
        Sessions::revoke_all(&data_dir.join("sessions.json"))?;
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
