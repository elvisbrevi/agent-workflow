//! One owner per installation, with its own OS account/server and CLI credentials.
pub mod access;
pub mod auth;
pub mod config;
mod policy;

use crate::{
    core::{Core, EnvironmentProbe},
    runner::{RunRequest, RunStarted},
    settings::GuiSettings,
};
use auth::{AccessRevocations, Owner, Session, Sessions};
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Extension, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use config::{private_directory, private_write, Authentication, WebConfig};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tower_http::services::ServeDir;

pub struct ApiError(pub StatusCode, pub String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}
impl From<String> for ApiError {
    fn from(error: String) -> Self {
        Self(StatusCode::BAD_REQUEST, error)
    }
}
fn denied(message: &str) -> ApiError {
    ApiError(StatusCode::FORBIDDEN, message.into())
}
fn unauthorized() -> ApiError {
    ApiError(
        StatusCode::UNAUTHORIZED,
        "login required or session expired".into(),
    )
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    sequence: u64,
    event: String,
    payload: Value,
}
#[derive(Default)]
struct Feed {
    sequence: u64,
    entries: VecDeque<Event>,
    bytes: usize,
}
impl Feed {
    fn push(&mut self, event: &str, payload: Value) {
        self.sequence += 1;
        let entry = Event {
            sequence: self.sequence,
            event: event.into(),
            payload,
        };
        self.bytes += serde_json::to_vec(&entry).unwrap().len();
        self.entries.push_back(entry);
        while self.entries.len() > 3000 || self.bytes > 2 * 1024 * 1024 {
            if let Some(entry) = self.entries.pop_front() {
                self.bytes -= serde_json::to_vec(&entry).unwrap().len();
            }
        }
    }
}
struct Bridge {
    token: String,
    local_url: Option<String>,
    run_id: Option<u64>,
}
struct Rate {
    since: Instant,
    requests: u32,
    logins: u32,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    started: Option<RunStarted>,
    args: Vec<String>,
    created_at: u64,
    exit: Option<Value>,
}

pub struct WebState {
    pub config: WebConfig,
    pub core: Core,
    owner: Option<Owner>,
    access: Option<access::Verifier>,
    revocations: Mutex<AccessRevocations>,
    sessions: Mutex<Sessions>,
    catalog: Value,
    data_dir: PathBuf,
    feed: Mutex<Feed>,
    bridges: Mutex<BTreeMap<String, Bridge>>,
    starts: Mutex<BTreeMap<String, Receipt>>,
    rate: Mutex<Rate>,
    client: reqwest::Client,
    pub stopping: AtomicBool,
    instance: String,
    _instance_lease: std::fs::File,
}
impl WebState {
    pub fn open(config: WebConfig, data_dir: PathBuf) -> Result<Arc<Self>, String> {
        config.validate()?;
        if !config.frontend_dir.join("index.html").is_file() {
            return Err("frontendDir needs a built index.html; run bun run build:web".into());
        }
        config::outside_checkout(&data_dir)?;
        private_directory(&data_dir)?;
        let instance_lease =
            crate::core::acquire_profile_lease(data_dir.join("web.instance.lock"))?;
        private_directory(&data_dir.join("uploads"))?;
        let (owner, access) = match &config.authentication {
            Authentication::Password => (
                Some(
                    serde_json::from_slice::<Owner>(
                        &std::fs::read(data_dir.join("owner.json")).map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?,
                ),
                None,
            ),
            Authentication::CloudflareAccess { access } => (
                None,
                Some(access::Verifier::new(access.clone()).map_err(|e| e.to_string())?),
            ),
        };
        let revocations = AccessRevocations::load(&data_dir.join("access-revocations.json"))?;
        let core = Core::open(config.settings_path.clone())?;
        let catalog = policy::catalog(core.load_catalog()?, &config)?;
        let sessions = Sessions::load(data_dir.join("sessions.json"))?;
        let receipts_path = data_dir.join("runs.json");
        let mut receipts: BTreeMap<String, Receipt> = if receipts_path.exists() {
            serde_json::from_slice(&std::fs::read(&receipts_path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("invalid runs file: {e}"))?
        } else {
            BTreeMap::new()
        };
        receipts.retain(|_, receipt| receipt.created_at + 7 * 86400 > auth::now());
        for receipt in receipts.values_mut() {
            if let Some(started) = &receipt.started {
                core.runs.continue_ids_after(started.id);
                if receipt.exit.is_none() {
                    receipt.exit = Some(
                        json!({"id":started.id,"code":null,"signal":null,"durationMs":0,"cancelled":true,"error":"server restarted; this run was not resumed"}),
                    );
                }
            }
        }
        private_write(&receipts_path, &receipts)?;
        // This client can only reach a registered interview on literal loopback.
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Arc::new(Self {
            config,
            core,
            owner,
            access,
            revocations: Mutex::new(revocations),
            sessions: Mutex::new(sessions),
            catalog,
            data_dir,
            feed: Mutex::new(Feed::default()),
            bridges: Mutex::new(BTreeMap::new()),
            starts: Mutex::new(receipts),
            rate: Mutex::new(Rate {
                since: Instant::now(),
                requests: 0,
                logins: 0,
            }),
            client,
            stopping: AtomicBool::new(false),
            instance: auth::random_token(),
            _instance_lease: instance_lease,
        }))
    }
    fn token(headers: &HeaderMap) -> Option<String> {
        let cookie = headers.get(header::COOKIE)?.to_str().ok()?;
        let matches: Vec<_> = cookie
            .split(';')
            .filter_map(|part| part.trim().split_once('='))
            .filter(|(name, _)| *name == auth::COOKIE)
            .collect();
        (matches.len() == 1).then(|| matches[0].1.to_string())
    }
    fn session(&self, headers: &HeaderMap, verified: Option<&access::Verified>) -> Option<Session> {
        self.sessions
            .lock()
            .unwrap()
            .get(&Self::token(headers)?)
            .filter(|session| match (&self.owner, &session.access, verified) {
                (Some(owner), None, None) => session.username == owner.username,
                (None, Some(bound), Some(current)) => bound == current,
                _ => false,
            })
    }
    fn push(&self, event: &str, payload: Value) {
        self.feed.lock().unwrap().push(event, payload);
    }
}

pub fn router(state: Arc<WebState>) -> Router {
    Router::new()
        .route("/health", get(|| async { Json(json!({"status":"ok"})) }))
        .route("/api/login", post(login))
        .route("/api/auth", get(authentication_info))
        .route("/api/access-session", post(access_session))
        .route("/api/session", get(session))
        .route("/api/logout", post(logout))
        .route("/api/rpc/{operation}", post(rpc))
        .route("/api/events", get(events))
        .route("/api/runs", get(runs))
        .route("/api/interviews/{key}/round", get(interview_round))
        .route("/api/interviews/{key}/answers", post(interview_answers))
        .route("/internal/interviews/{key}", post(register_interview))
        .fallback_service(ServeDir::new(&state.config.frontend_dir))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), secure))
        .with_state(state)
}

async fn secure(
    State(state): State<Arc<WebState>>,
    mut request: axum::http::Request<Body>,
    next: Next,
) -> Response {
    let checked = check_request(&state, &mut request).await;
    let mut response = match checked {
        Ok(()) => next.run(request).await,
        Err(error) => error.into_response(),
    };
    let rate_limited = response.status() == StatusCode::TOO_MANY_REQUESTS;
    let headers = response.headers_mut();
    headers.insert("cache-control", "no-store".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    headers.insert("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'".parse().unwrap());
    headers.insert(
        "strict-transport-security",
        "max-age=31536000".parse().unwrap(),
    );
    if rate_limited {
        headers.insert("retry-after", "60".parse().unwrap());
    }
    response
}

async fn check_request(
    state: &Arc<WebState>,
    request: &mut axum::http::Request<Body>,
) -> Result<(), ApiError> {
    let path = request.uri().path();
    let headers = request.headers();
    if headers.get_all(header::HOST).iter().count() != 1
        || headers.get_all(header::ORIGIN).iter().count() > 1
    {
        return Err(denied("ambiguous Host or Origin"));
    }
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let local = host == state.config.listen.to_string();
    if path.starts_with("/internal/") {
        if !local || headers.contains_key(header::ORIGIN) {
            return Err(ApiError(StatusCode::NOT_FOUND, "not found".into()));
        }
        return Ok(()); // Short-lived per-run bearer authorization is checked by the callback.
    }
    if !(path == "/health" && local)
        && !host.eq_ignore_ascii_case(&state.config.host())
        && !host.eq_ignore_ascii_case(&format!("{}:443", state.config.host()))
    {
        return Err(denied("unexpected Host"));
    }
    if headers
        .get(header::ORIGIN)
        .is_some_and(|origin| origin.to_str().ok() != Some(state.config.origin().as_str()))
    {
        return Err(denied("unexpected Origin"));
    }
    let access_document_navigation = state.access.is_some()
        && request.method() == axum::http::Method::GET
        && path == "/"
        && headers
            .get("sec-fetch-mode")
            .is_some_and(|mode| mode == "navigate")
        && headers
            .get("sec-fetch-dest")
            .is_some_and(|destination| destination == "document");
    if !access_document_navigation
        && headers
            .get("sec-fetch-site")
            .is_some_and(|site| site == "cross-site")
    {
        return Err(denied("cross-site request rejected"));
    }
    {
        let mut rate = state.rate.lock().unwrap();
        if rate.since.elapsed() >= Duration::from_secs(60) {
            *rate = Rate {
                since: Instant::now(),
                requests: 0,
                logins: 0,
            };
        }
        rate.requests += 1;
        let login = path == "/api/login" || path == "/api/access-session";
        if login {
            rate.logins += 1;
        }
        if rate.requests > 600 || (login && rate.logins > 5) {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "rate limit exceeded; retry in a minute".into(),
            ));
        }
    }
    if path == "/health" && local {
        return Ok(());
    }
    if path == "/api/auth" && request.method() == axum::http::Method::GET {
        return Ok(());
    }
    if path == "/api/login" && state.access.is_some() {
        return Err(denied(
            "password login is disabled; use Cloudflare Access with GitHub",
        ));
    }
    let verified = if let Some(verifier) = &state.access {
        let verified = verifier.verify(headers).await.map_err(|code| {
            ApiError(
                code,
                "Cloudflare Access authentication unavailable or invalid".into(),
            )
        })?;
        if !verifier.owns(&verified) {
            return Err(denied(
                "GitHub identity is not bound to this installation; contact the local owner",
            ));
        }
        if !state.revocations.lock().unwrap().permits(&verified) {
            return Err(unauthorized());
        }
        Some(verified)
    } else {
        None
    };
    if !path.starts_with("/api/") {
        return Ok(());
    }
    let modifying = request.method() != axum::http::Method::GET;
    if modifying
        && (headers.get(header::ORIGIN).and_then(|h| h.to_str().ok())
            != Some(state.config.origin().as_str())
            || headers.get("x-lz-web").and_then(|h| h.to_str().ok()) != Some("1")
            || !headers
                .get(header::CONTENT_TYPE)
                .and_then(|h| h.to_str().ok())
                .is_some_and(|h| h.split(';').next() == Some("application/json")))
    {
        return Err(denied("same-origin JSON and X-LZ-Web are required"));
    }
    if path == "/api/access-session" {
        request
            .extensions_mut()
            .insert(verified.ok_or_else(|| denied("Cloudflare Access is not configured"))?);
        return Ok(());
    }
    if path == "/api/login" {
        return Ok(());
    }
    let session = state
        .session(headers, verified.as_ref())
        .ok_or_else(unauthorized)?;
    if modifying
        && !headers
            .get("x-csrf-token")
            .and_then(|h| h.to_str().ok())
            .is_some_and(|token| auth::equal(token, &session.csrf))
    {
        return Err(denied("invalid CSRF token"));
    }
    request.extensions_mut().insert(session);
    Ok(())
}

async fn authentication_info(State(state): State<Arc<WebState>>) -> Json<Value> {
    Json(match &state.config.authentication {
        Authentication::Password => json!({"mode":"password"}),
        // The protected origin lets Access generate its own login metadata and redirect.
        Authentication::CloudflareAccess { .. } => {
            json!({"mode":"cloudflareAccess","loginUrl":state.config.origin(),"logoutUrl":"/cdn-cgi/access/logout"})
        }
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
async fn access_session(
    State(state): State<Arc<WebState>>,
    Extension(verified): Extension<access::Verified>,
    Json(_): Json<Empty>,
) -> Result<Response, ApiError> {
    let seconds = state
        .config
        .session_seconds
        .min(verified.expires_at.saturating_sub(auth::now()));
    if seconds == 0 {
        return Err(unauthorized());
    }
    let (token, session) =
        state
            .sessions
            .lock()
            .unwrap()
            .create_bound("GitHub", seconds, Some(verified))?;
    let mut response = Json(session.public()).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        auth::cookie(&token, seconds).parse().unwrap(),
    );
    Ok(response)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Login {
    username: String,
    password: String,
}
async fn login(
    State(state): State<Arc<WebState>>,
    Json(login): Json<Login>,
) -> Result<Response, ApiError> {
    if login.username.len() > 80 || login.password.len() > 1024 {
        return Err(unauthorized());
    }
    let check = state.clone();
    let valid = tokio::task::spawn_blocking(move || {
        check
            .owner
            .as_ref()
            .is_some_and(|owner| owner.verify(&login.username, &login.password))
    })
    .await
    .map_err(|_| unauthorized())?;
    if !valid {
        return Err(unauthorized());
    }
    let (token, session) = state.sessions.lock().unwrap().create(
        &state.owner.as_ref().ok_or_else(unauthorized)?.username,
        state.config.session_seconds,
    )?;
    let mut response = Json(session.public()).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        auth::cookie(&token, state.config.session_seconds)
            .parse()
            .unwrap(),
    );
    Ok(response)
}
async fn session(Extension(session): Extension<Session>) -> Json<Value> {
    Json(session.public())
}
async fn logout(
    State(state): State<Arc<WebState>>,
    Extension(session): Extension<Session>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if let Some(verified) = &session.access {
        state
            .revocations
            .lock()
            .unwrap()
            .revoke(&state.data_dir.join("access-revocations.json"), verified)?;
    }
    state
        .sessions
        .lock()
        .unwrap()
        .revoke(&WebState::token(&headers).ok_or_else(unauthorized)?)?;
    let mut response = Json(
        json!({"ok":true,"logoutUrl":session.access.as_ref().map(|_| "/cdn-cgi/access/logout")}),
    )
    .into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, auth::cookie("", 0).parse().unwrap());
    Ok(response)
}

async fn rpc(
    State(state): State<Arc<WebState>>,
    Path(operation): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    if state.stopping.load(Ordering::SeqCst) {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "server is stopping".into(),
        ));
    }
    let value = tokio::task::spawn_blocking(move || -> Result<Value, ApiError> {
        match operation.as_str() {
            "get_settings" => { let mut document = state.core.get_settings(); document.settings = policy::public_settings(document.settings); Ok(serde_json::to_value(document).unwrap()) }
            "save_settings" => {
                let _gate = state.starts.lock().unwrap();
                let next: GuiSettings = serde_json::from_value(body["settings"].clone()).map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
                let settings = policy::preferences(&state.core.settings()?, next)?;
                let mut document = state.core.save_settings(settings)?; document.settings = policy::public_settings(document.settings);
                Ok(serde_json::to_value(document).unwrap())
            }
            "load_catalog" => Ok(state.catalog.clone()),
            "start_run" => {
                let request_id = headers.get("x-request-id").and_then(|h| h.to_str().ok()).filter(|id| id.len() >= 16 && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')).ok_or_else(|| denied("start_run needs X-Request-ID"))?;
                let mut starts = state.starts.lock().unwrap();
                if let Some(receipt) = starts.get(request_id) { return receipt.started.as_ref().map(|started| serde_json::to_value(started).unwrap()).ok_or(ApiError(StatusCode::CONFLICT, "previous start has no acknowledgement; inspect the server history before retrying".into())); }
                starts.retain(|_, receipt| receipt.created_at + 7 * 86400 > auth::now() || receipt.exit.is_none());
                if starts.len() >= 1024 { return Err(ApiError(StatusCode::CONFLICT, "idempotency history is full; inspect the server history".into())); }
                if state.core.runs.active_count() >= state.config.max_runs { return Err(ApiError(StatusCode::CONFLICT, "maximum simultaneous runs reached".into())); }
                let mut request: RunRequest = serde_json::from_value(body["request"].clone()).map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
                let settings = state.core.settings()?;
                let args = request.args.clone();
                policy::validate(&mut request, &state.catalog, &settings, &state.data_dir.join("uploads"))?;
                starts.insert(request_id.into(), Receipt { started: None, args: args.clone(), created_at: auth::now(), exit: None });
                private_write(&state.data_dir.join("runs.json"), &*starts)?;
                let key = auth::random_token(); let token = auth::random_token();
                state.bridges.lock().unwrap().insert(key.clone(), Bridge { token: token.clone(), local_url: None, run_id: None });
                let bridge = json!({"callbackUrl":format!("http://{}/internal/interviews/{key}", state.config.listen),"token":token,"publicPath":format!("/api/interviews/{key}")});
                let events = state.clone(); let event_key = key.clone(); let event_request = request_id.to_string();
                let sink = Arc::new(move |event: &str, mut payload: Value| {
                    if event == crate::runner::EXIT_EVENT {
                        events.bridges.lock().unwrap().remove(&event_key);
                        let mut receipts = events.starts.lock().unwrap();
                        if let Some(receipt) = receipts.get_mut(&event_request) { receipt.exit = Some(payload.clone()); }
                        if private_write(&events.data_dir.join("runs.json"), &*receipts).is_err() { payload["error"] = json!("could not persist the run result; inspect the CLI run log"); }
                    }
                    if let Some(line) = payload.get_mut("line") { if let Some(text) = line.as_str().filter(|text| text.len() > 65536) { *line = Value::String(text.chars().take(16000).collect::<String>() + " [truncated]"); } }
                    events.push(event, payload);
                });
                let overrides = BTreeMap::from([("LAZY_WORKFLOW_WEB_BRIDGE".into(), bridge.to_string())]);
                let started = match state.core.runs.start_with_environment(sink, &settings, request, overrides, &["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "TUNNEL_TOKEN", "TUNNEL_TOKEN_FILE"]) {
                    Ok(started) => started,
                    Err(error) => {
                        state.bridges.lock().unwrap().remove(&key);
                        if let Some(receipt) = starts.get_mut(request_id) { receipt.exit = Some(json!({"error":"process could not start"})); }
                        private_write(&state.data_dir.join("runs.json"), &*starts)?;
                        return Err(error.into());
                    }
                };
                if let Some(bridge) = state.bridges.lock().unwrap().get_mut(&key) { bridge.run_id = Some(started.id); }
                state.push("lz://run-started", json!({"started":started,"args":args}));
                starts.get_mut(request_id).unwrap().started = Some(started.clone());
                private_write(&state.data_dir.join("runs.json"), &*starts)?;
                Ok(serde_json::to_value(started).unwrap())
            }
            "cancel_run" => {
                let id = body["id"].as_u64().ok_or_else(|| denied("invalid run ID"))?;
                Ok(json!(state.core.runs.cancel(id)?))
            }
            "read_run_log" => {
                let limit = body["limit"].as_u64().unwrap_or(4000).clamp(1, 4000) as usize;
                Ok(serde_json::to_value(state.core.read_run_log(limit)?).unwrap())
            }
            "diagnose" => {
                // The caller cannot declare a secret to be public, or probe arbitrary variables.
                let variables = state.catalog["environment"].as_array().unwrap().iter().filter_map(|v| Some(EnvironmentProbe { name: v["name"].as_str()?.into(), secret: true })).collect();
                Ok(serde_json::to_value(state.core.diagnose(variables)?).unwrap())
            }
            "reload_environment" => { crate::environment::reload_shell_environment(); Ok(Value::Null) }
            "upload_file" => {
                let content = body["content"].as_str().ok_or_else(|| denied("upload needs UTF-8 text content"))?;
                if content.len() > 1024 * 1024 || content.contains('\0') { return Err(ApiError(StatusCode::PAYLOAD_TOO_LARGE, "only text files up to 1 MiB are supported".into())); }
                let directory = state.data_dir.join("uploads");
                if std::fs::read_dir(&directory).map_err(|e| e.to_string())?.count() >= 100 { return Err(ApiError(StatusCode::CONFLICT, "upload storage is full; remove unused uploads locally".into())); }
                let path = directory.join(format!("{}.txt", auth::random_token()));
                // JSON encoding is inappropriate for a CLI's text-file argument.
                let mut options = std::fs::OpenOptions::new(); options.write(true).create_new(true);
                #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
                use std::io::Write;
                options.open(&path).and_then(|mut f| f.write_all(content.as_bytes())).map_err(|e| e.to_string())?;
                Ok(json!({"path":path}))
            }
            _ => Err(denied("operation is not exposed over HTTP")),
        }
    }).await.map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "backend task failed".into()))??;
    Ok(Json(value))
}

#[derive(Deserialize)]
struct Cursor {
    after: Option<u64>,
}
async fn events(State(state): State<Arc<WebState>>, Query(cursor): Query<Cursor>) -> Json<Value> {
    let feed = state.feed.lock().unwrap();
    Json(
        json!({"events":feed.entries.iter().filter(|e| e.sequence > cursor.after.unwrap_or(0)).collect::<Vec<_>>(),"cursor":feed.sequence,"oldestSequence":feed.entries.front().map(|e| e.sequence),"instance":state.instance}),
    )
}

async fn runs(State(state): State<Arc<WebState>>) -> Json<Value> {
    let starts = state.starts.lock().unwrap();
    let mut runs: Vec<_> = starts
        .values()
        .filter(|receipt| receipt.started.is_some())
        .cloned()
        .collect();
    runs.sort_by_key(|receipt| receipt.created_at);
    if runs.len() > 40 {
        runs.drain(..runs.len() - 40);
    }
    Json(json!(runs))
}

async fn register_interview(
    State(state): State<Arc<WebState>>,
    Path(key): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let mut bridges = state.bridges.lock().unwrap();
    let bridge = bridges
        .get_mut(&key)
        .ok_or_else(|| denied("unknown run callback"))?;
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .ok_or_else(|| denied("callback authentication required"))?;
    if !auth::equal(bearer, &bridge.token) {
        return Err(denied("callback authentication required"));
    }
    let url = body["url"]
        .as_str()
        .and_then(|url| url::Url::parse(url).ok())
        .ok_or_else(|| denied("invalid interview URL"))?;
    let token = url
        .path()
        .strip_prefix("/i/")
        .ok_or_else(|| denied("invalid interview path"))?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.port() == Some(0)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || token.len() < 16
        || token.len() > 128
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(denied("interview must be a token path on literal loopback"));
    }
    if bridge.local_url.is_some() {
        return Err(denied("interview callback already registered"));
    }
    bridge.local_url = Some(url.to_string());
    Ok(Json(json!({"ok":true})))
}

fn interview_url(state: &WebState, key: &str, suffix: &str) -> Result<String, ApiError> {
    state
        .bridges
        .lock()
        .unwrap()
        .get(key)
        .and_then(|bridge| bridge.local_url.as_ref())
        .map(|url| format!("{url}/{suffix}"))
        .ok_or(ApiError(
            StatusCode::NOT_FOUND,
            "interview is not active".into(),
        ))
}
async fn interview_round(
    State(state): State<Arc<WebState>>,
    Path(key): Path<String>,
) -> Result<Response, ApiError> {
    let response = state
        .client
        .get(interview_url(&state, &key, "round")?)
        .send()
        .await
        .map_err(|_| {
            ApiError(
                StatusCode::BAD_GATEWAY,
                "private interview unavailable".into(),
            )
        })?;
    interview_response(response).await
}
async fn interview_answers(
    State(state): State<Arc<WebState>>,
    Path(key): Path<String>,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let response = state
        .client
        .post(interview_url(&state, &key, "answers")?)
        .json(&body)
        .send()
        .await
        .map_err(|_| {
            ApiError(
                StatusCode::BAD_GATEWAY,
                "private interview unavailable".into(),
            )
        })?;
    interview_response(response).await
}
async fn interview_response(response: reqwest::Response) -> Result<Response, ApiError> {
    let status = response.status();
    let body = response.json::<Value>().await.map_err(|_| {
        ApiError(
            StatusCode::BAD_GATEWAY,
            "invalid private interview response".into(),
        )
    })?;
    Ok((status, Json(body)).into_response())
}

pub fn load_config(data_dir: &std::path::Path) -> Result<WebConfig, String> {
    let config: WebConfig = serde_json::from_slice(
        &std::fs::read(data_dir.join("web.json"))
            .map_err(|e| format!("web.json unavailable: {e}; run lz-web init"))?,
    )
    .map_err(|e| e.to_string())?;
    config.validate()?;
    Ok(config)
}

pub fn initialize(
    data_dir: &std::path::Path,
    config: &WebConfig,
    owner: Option<&Owner>,
) -> Result<(), String> {
    config.validate()?;
    config::outside_checkout(data_dir)?;
    private_directory(data_dir)?;
    let _instance = crate::core::acquire_profile_lease(data_dir.join("web.instance.lock"))?;
    if data_dir.join("web.json").exists() || data_dir.join("owner.json").exists() {
        return Err("installation already initialized; existing configuration is preserved".into());
    }
    match (&config.authentication, owner) {
        (Authentication::Password, Some(owner)) => {
            private_write(&data_dir.join("owner.json"), owner)?
        }
        (Authentication::CloudflareAccess { .. }, None) => {}
        _ => return Err("owner credentials must match the authentication mode".into()),
    }
    private_write(&data_dir.join("web.json"), config)
}

#[cfg(all(test, unix))]
mod tests;
