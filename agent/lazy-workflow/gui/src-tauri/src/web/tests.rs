use super::*;
use axum::http::Request;
use tower::ServiceExt;

struct Fixture {
    root: tempfile::TempDir,
    config: WebConfig,
    state: Arc<WebState>,
}
impl Fixture {
    fn new(username: &str) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let directory = root.path();
        std::fs::create_dir(directory.join("frontend")).unwrap();
        std::fs::write(directory.join("frontend/index.html"), "<h1>synthetic</h1>").unwrap();
        let catalog = json!({"schemaVersion":1,"environment":[{"name":"SYNTHETIC_SECRET","secret":false}],"groups":[],"commands":[{"name":"code","effect":"session","flags":[],"groups":[]},{"name":"git-branch-list","effect":"read","flags":[{"flag":"--working-directory","kind":"directory"}],"groups":[]},{"name":"credentials-get","effect":"read","flags":[],"groups":[]}]});
        std::fs::write(directory.join("catalog.json"), catalog.to_string()).unwrap();
        let launcher = directory.join("fake-lz");
        std::fs::write(&launcher, format!("#!/bin/sh\nif [ \"$1\" = catalog ]; then cat '{}'; exit 0; fi\nprintf 'run\\n' >> '{}'\nprintf '{{\"synthetic\":true}}\\n'\n", directory.join("catalog.json").display(), directory.join("spawned").display())).unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700)).unwrap();
        let settings_path = directory.join("gui.json");
        let settings = GuiSettings {
            lz_command: launcher.to_string_lossy().into_owned(),
            inherit_shell_environment: false,
            repositories: vec![directory.to_string_lossy().into_owned()],
            active_repository: Some(directory.to_string_lossy().into_owned()),
            environment: BTreeMap::from([
                (
                    "SYNTHETIC_SECRET".into(),
                    "synthetic-not-for-browser".into(),
                ),
                (
                    "LAZY_WORKFLOW_LOG_FILE".into(),
                    directory
                        .join("cli-runs.jsonl")
                        .to_string_lossy()
                        .into_owned(),
                ),
            ]),
            ..GuiSettings::default()
        };
        crate::settings::save(&settings_path, &settings).unwrap();
        let config = WebConfig {
            schema_version: 1,
            public_url: "https://workflow.test".into(),
            listen: "127.0.0.1:8234".parse().unwrap(),
            settings_path,
            frontend_dir: directory.join("frontend"),
            session_seconds: 60,
            max_runs: 1,
            allowed_commands: vec!["code".into(), "git-branch-list".into()],
            authentication: Authentication::Password,
        };
        initialize(
            directory,
            &config,
            Some(&Owner::create(username.into(), "synthetic-passphrase").unwrap()),
        )
        .unwrap();
        let state = WebState::open(config.clone(), directory.into()).unwrap();
        Self {
            root,
            config,
            state,
        }
    }
}

fn request(method: &str, path: &str, cookie: &str, csrf: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(path)
        .header("host", "workflow.test")
        .header("origin", "https://workflow.test")
        .header("content-type", "application/json")
        .header("x-lz-web", "1")
        .header("x-csrf-token", csrf)
        .header("cookie", cookie)
        .header("x-request-id", "synthetic-request-id-0001")
        .body(Body::from(body.to_string()))
        .unwrap()
}
async fn value(response: Response) -> Value {
    serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 3 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap()
}
async fn login_cookie(app: &Router, username: &str) -> (String, String) {
    let response = app
        .clone()
        .oneshot(request(
            "POST",
            "/api/login",
            "",
            "",
            json!({"username":username,"password":"synthetic-passphrase"}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .to_string();
    assert!(
        cookie.contains("Secure")
            && cookie.contains("HttpOnly")
            && cookie.contains("SameSite=Strict")
    );
    let csrf = value(response).await["csrf"].as_str().unwrap().to_string();
    (cookie.split(';').next().unwrap().to_string(), csrf)
}

#[test]
fn an_installation_cannot_start_twice_even_with_a_different_settings_path() {
    let fixture = Fixture::new("alice");
    let mut another = fixture.config.clone();
    another.settings_path = fixture.root.path().join("another-gui.json");
    assert!(WebState::open(another, fixture.root.path().into()).is_err());
    assert!(initialize(
        fixture.root.path(),
        &fixture.config,
        Some(&Owner::create("bob".into(), "another-synthetic-password").unwrap())
    )
    .is_err());
}

#[tokio::test]
async fn authentication_origin_host_csrf_logout_and_rate_limits_are_enforced() {
    let fixture = Fixture::new("alice");
    let app = router(fixture.state.clone());
    let response = app
        .clone()
        .oneshot(request("GET", "/api/session", "", "", Value::Null))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let (cookie, csrf) = login_cookie(&app, "alice").await;
    let response = app
        .clone()
        .oneshot(request(
            "POST",
            "/api/rpc/load_catalog",
            &cookie,
            "wrong",
            json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    for (header, value) in [
        ("origin", "https://attacker.test"),
        ("host", "attacker.test"),
    ] {
        let mut bad = request("POST", "/api/rpc/load_catalog", &cookie, &csrf, json!({}));
        bad.headers_mut().insert(header, value.parse().unwrap());
        assert_eq!(
            app.clone().oneshot(bad).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
    let response = app
        .clone()
        .oneshot(request("POST", "/api/logout", &cookie, &csrf, json!({})))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        app.clone()
            .oneshot(request("GET", "/api/session", &cookie, "", Value::Null))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    for _ in 0..4 {
        assert_eq!(
            app.clone()
                .oneshot(request(
                    "POST",
                    "/api/login",
                    "",
                    "",
                    json!({"username":"nobody","password":"synthetic-wrong"})
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        app.oneshot(request(
            "POST",
            "/api/login",
            "",
            "",
            json!({"username":"alice","password":"synthetic-passphrase"})
        ))
        .await
        .unwrap()
        .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn browser_cannot_reconfigure_launcher_read_secrets_select_another_profile_or_capture_arbitrary_commands(
) {
    let fixture = Fixture::new("alice");
    let app = router(fixture.state.clone());
    let (cookie, csrf) = login_cookie(&app, "alice").await;
    let response = app
        .clone()
        .oneshot(request(
            "POST",
            "/api/rpc/get_settings",
            &cookie,
            &csrf,
            json!({}),
        ))
        .await
        .unwrap();
    let document = value(response).await;
    assert_eq!(document["settings"]["environment"], json!({}));
    let mut settings = document["settings"].clone();
    settings["lzCommand"] = json!("/bin/sh");
    assert_eq!(
        app.clone()
            .oneshot(request(
                "POST",
                "/api/rpc/save_settings",
                &cookie,
                &csrf,
                json!({"settings":settings})
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    for operation in ["credentials-get", "capture_lz", "unknown"] {
        assert_eq!(
            app.clone()
                .oneshot(request(
                    "POST",
                    &format!("/api/rpc/{operation}"),
                    &cookie,
                    &csrf,
                    json!({"args":["credentials-get"]})
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        app.clone()
            .oneshot(request(
                "POST",
                "/api/rpc/start_run",
                &cookie,
                &csrf,
                json!({"request":{"args":["code"],"stdin":null,"cwd":null,"profile":"bob"}})
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let diagnostics = value(
        app.oneshot(request(
            "POST",
            "/api/rpc/diagnose",
            &cookie,
            &csrf,
            json!({"variables":[{"name":"SYNTHETIC_SECRET","secret":false}]}),
        ))
        .await
        .unwrap(),
    )
    .await;
    assert!(diagnostics["variables"]
        .as_array()
        .unwrap()
        .iter()
        .all(|variable| variable["value"].is_null()));
    assert!(!diagnostics
        .to_string()
        .contains("synthetic-not-for-browser"));
}

#[tokio::test]
async fn sessions_are_isolated_and_settings_runs_and_idempotency_survive_restart() {
    let a = Fixture::new("alice");
    let b = Fixture::new("bob");
    let app = router(a.state.clone());
    let (cookie, csrf) = login_cookie(&app, "alice").await;
    assert_eq!(
        router(b.state.clone())
            .oneshot(request("GET", "/api/session", &cookie, "", Value::Null))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let response = app
        .clone()
        .oneshot(request(
            "POST",
            "/api/rpc/get_settings",
            &cookie,
            &csrf,
            json!({}),
        ))
        .await
        .unwrap();
    let mut settings = value(response).await["settings"].clone();
    settings["theme"] = json!("dark");
    assert_eq!(
        app.clone()
            .oneshot(request(
                "POST",
                "/api/rpc/save_settings",
                &cookie,
                &csrf,
                json!({"settings":settings})
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let body = json!({"request":{"args":["code"],"stdin":null,"cwd":null}});
    let first = value(
        app.clone()
            .oneshot(request(
                "POST",
                "/api/rpc/start_run",
                &cookie,
                &csrf,
                body.clone(),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert!(first["id"].as_u64().is_some(), "{first}");
    let second = value(
        app.clone()
            .oneshot(request(
                "POST",
                "/api/rpc/start_run",
                &cookie,
                &csrf,
                body.clone(),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(first, second);
    for _ in 0..100 {
        if a.state
            .starts
            .lock()
            .unwrap()
            .values()
            .all(|receipt| receipt.exit.is_some())
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        std::fs::read_to_string(a.root.path().join("spawned")).unwrap(),
        "run\n"
    );
    let Fixture {
        root,
        config,
        state,
    } = a;
    drop(app);
    drop(state);
    let restarted = WebState::open(config, root.path().into()).unwrap();
    let app = router(restarted.clone());
    assert_eq!(
        app.clone()
            .oneshot(request("GET", "/api/session", &cookie, "", Value::Null))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(restarted.core.settings().unwrap().theme, "dark");
    let third = value(
        app.oneshot(request("POST", "/api/rpc/start_run", &cookie, &csrf, body))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(third, first);
    assert_eq!(
        std::fs::read_to_string(root.path().join("spawned")).unwrap(),
        "run\n"
    );
}

#[tokio::test]
async fn private_interview_callback_needs_its_own_bearer_and_rejects_arbitrary_endpoints() {
    let fixture = Fixture::new("alice");
    let app = router(fixture.state.clone());
    let key = "a".repeat(64);
    let token = "b".repeat(64);
    fixture.state.bridges.lock().unwrap().insert(
        key.clone(),
        Bridge {
            token: token.clone(),
            local_url: None,
            run_id: Some(1),
        },
    );
    let path = format!("/internal/interviews/{key}");
    let body = json!({"url":"http://127.0.0.1:9999/i/synthetic-private-interview"});
    let public = request("POST", &path, "", "", body.clone());
    assert_eq!(
        app.clone().oneshot(public).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    let callback = |bearer: &str, body: Value| {
        Request::builder()
            .method("POST")
            .uri(&path)
            .header("host", "127.0.0.1:8234")
            .header("authorization", format!("Bearer {bearer}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    assert_eq!(
        app.clone()
            .oneshot(callback("wrong", body.clone()))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    for url in [
        "http://metadata.internal/i/synthetic-private-interview",
        "http://127.0.0.1:9999/admin",
        "http://127.0.0.1:9999/i/synthetic-private-interview?endpoint=admin",
    ] {
        assert_eq!(
            app.clone()
                .oneshot(callback(&token, json!({"url":url})))
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        app.clone()
            .oneshot(callback(&token, body.clone()))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        app.oneshot(callback(&token, body)).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn access_replaces_password_requires_assertion_and_csrf_and_blocks_logout_replay_after_restart(
) {
    use access::tests::{claims, config, identity, mock_verifier, mount_identity, token, SUBJECT};
    let mut fixture = Fixture::new("alice");
    let (verifier, server) = mock_verifier().await;
    mount_identity(&server, identity(SUBJECT, "123456")).await;
    fixture.config.authentication = Authentication::CloudflareAccess { access: config() };
    fixture.config.session_seconds = 120;
    let state = Arc::get_mut(&mut fixture.state).unwrap();
    state.config = fixture.config.clone();
    state.owner = None;
    state.access = Some(verifier);
    let app = router(fixture.state.clone());
    let mut input = claims(SUBJECT);
    input["exp"] = json!(auth::now() + 30);
    let assertion = token(&input, "synthetic-key");
    let signed = |method: &str, path: &str, cookie: &str, csrf: &str, body: Value| {
        let mut value = request(method, path, cookie, csrf, body);
        value
            .headers_mut()
            .insert("cf-access-jwt-assertion", assertion.parse().unwrap());
        value
    };
    // OAuth returns through a cross-site top-level document navigation.
    for (method, path, mode, destination, expected) in [
        ("GET", "/", "navigate", "document", StatusCode::OK),
        ("POST", "/", "navigate", "document", StatusCode::FORBIDDEN),
        (
            "GET",
            "/api/session",
            "navigate",
            "document",
            StatusCode::FORBIDDEN,
        ),
        ("GET", "/", "cors", "document", StatusCode::FORBIDDEN),
        ("GET", "/", "navigate", "iframe", StatusCode::FORBIDDEN),
    ] {
        let mut navigation = signed(method, path, "", "", Value::Null);
        navigation.headers_mut().remove(header::ORIGIN);
        for (name, value) in [
            ("sec-fetch-site", "cross-site"),
            ("sec-fetch-mode", mode),
            ("sec-fetch-dest", destination),
        ] {
            navigation
                .headers_mut()
                .insert(name, value.parse().unwrap());
        }
        assert_eq!(
            app.clone().oneshot(navigation).await.unwrap().status(),
            expected
        );
    }
    let info = value(
        app.clone()
            .oneshot(request("GET", "/api/auth", "", "", Value::Null))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(info["mode"], "cloudflareAccess");
    assert_eq!(info["loginUrl"], "https://workflow.test");
    assert_eq!(info["logoutUrl"], "/cdn-cgi/access/logout");
    assert!(!info.to_string().contains("123456"));
    assert_eq!(
        app.clone()
            .oneshot(signed(
                "POST",
                "/api/login",
                "",
                "",
                json!({"username":"alice","password":"synthetic-passphrase"})
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    for path in ["/api/access-session", "/api/rpc/load_catalog"] {
        assert_eq!(
            app.clone()
                .oneshot(request("POST", path, "", "", json!({})))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let response = app
        .clone()
        .oneshot(signed("POST", "/api/access-session", "", "", json!({})))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let document = value(response).await;
    assert!(document["expiresAt"].as_u64().unwrap() <= input["exp"].as_u64().unwrap());
    assert!(document.get("access").is_none());
    let csrf = document["csrf"].as_str().unwrap();
    assert_eq!(
        app.clone()
            .oneshot(request("GET", "/api/session", &cookie, "", Value::Null))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let mut forged = request("GET", "/api/session", &cookie, "", Value::Null);
    forged.headers_mut().insert(
        "cf-access-authenticated-user-email",
        "synthetic@example.test".parse().unwrap(),
    );
    assert_eq!(
        app.clone().oneshot(forged).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.clone()
            .oneshot(signed(
                "POST",
                "/api/rpc/load_catalog",
                &cookie,
                "wrong",
                json!({})
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.clone()
            .oneshot(signed(
                "POST",
                "/api/rpc/load_catalog",
                &cookie,
                csrf,
                json!({})
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let response = app
        .clone()
        .oneshot(signed("POST", "/api/logout", &cookie, csrf, json!({})))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(value(response).await["logoutUrl"], "/cdn-cgi/access/logout");
    assert_eq!(
        app.clone()
            .oneshot(signed("POST", "/api/access-session", "", "", json!({})))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    drop(app);
    drop(fixture.state);
    let mut restarted = WebState::open(fixture.config, fixture.root.path().into()).unwrap();
    let (verifier, second_server) = mock_verifier().await;
    mount_identity(&second_server, identity(SUBJECT, "123456")).await;
    Arc::get_mut(&mut restarted).unwrap().access = Some(verifier);
    assert_eq!(
        router(restarted)
            .oneshot(signed("POST", "/api/access-session", "", "", json!({})))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn an_unbound_or_different_github_subject_cannot_open_the_owner_installation() {
    use access::tests::{claims, config, identity, mock_verifier, mount_identity, token, SUBJECT};
    for owner_subject in [None, Some("other-github-user".to_string())] {
        let mut fixture = Fixture::new("alice");
        let (mut verifier, server) = mock_verifier().await;
        mount_identity(&server, identity(SUBJECT, "123456")).await;
        // Production config is immutable and never selected by a request.
        verifier.set_test_owner(owner_subject.clone());
        let state = Arc::get_mut(&mut fixture.state).unwrap();
        let mut access = config();
        access.owner_subject = owner_subject;
        state.config.authentication = Authentication::CloudflareAccess { access };
        state.owner = None;
        state.access = Some(verifier);
        let mut request = request("POST", "/api/access-session", "", "", json!({}));
        request.headers_mut().insert(
            "cf-access-jwt-assertion",
            token(&claims(SUBJECT), "synthetic-key").parse().unwrap(),
        );
        assert_eq!(
            router(fixture.state)
                .oneshot(request)
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
}
