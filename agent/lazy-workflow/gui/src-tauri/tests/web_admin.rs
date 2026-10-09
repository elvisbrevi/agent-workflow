#![cfg(feature = "web")]
use serde_json::{json, Value};
use std::{
    io::Write,
    path::Path,
    process::{Command, Output, Stdio},
};

fn command(action: &str, root: &Path, flags: &[&str], input: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_lz-web"))
        .arg(action)
        .arg("--data-dir")
        .arg(root)
        .args(flags)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Err(error) = child.stdin.take().unwrap().write_all(input.as_bytes()) {
        // An action that rejects password authentication exits without reading stdin.
        assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
    }
    child.wait_with_output().unwrap()
}
fn setup(root: &Path) -> std::path::PathBuf {
    let file = root.join("access.json");
    std::fs::write(&file, json!({"publicUrl":"https://app.example.test","access":{"issuer":"https://synthetic.cloudflareaccess.com","audience":"a".repeat(64),"accountId":"b".repeat(32),"githubIdpId":"f43dbf29-6f6b-4f38-ac06-d8a973fb4e47"}}).to_string()).unwrap();
    file
}
fn identity() -> Value {
    json!({"id":"123456","user_uuid":"2f102676-72cd-4d60-9f49-a94a33f9b231","account_id":"b".repeat(32),"idp":{"id":"f43dbf29-6f6b-4f38-ac06-d8a973fb4e47","type":"github"}})
}
fn read(root: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(root.join("web.json")).unwrap()).unwrap()
}

#[test]
fn access_initialization_binding_recovery_and_password_rejection_are_operator_local() {
    let root = tempfile::tempdir().unwrap();
    let setup = setup(root.path());
    let settings = root.path().join("gui.json");
    let frontend = root.path().join("frontend");
    let output = command(
        "init",
        root.path(),
        &[
            "--public-url",
            "https://app.example.test",
            "--settings",
            settings.to_str().unwrap(),
            "--frontend",
            frontend.to_str().unwrap(),
            "--access-config",
            setup.to_str().unwrap(),
        ],
        "",
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!root.path().join("owner.json").exists());
    assert_eq!(
        read(root.path())["authentication"]["mode"],
        "cloudflareAccess"
    );
    assert_eq!(
        read(root.path())["authentication"]["access"]["ownerSubject"],
        Value::Null
    );
    let output = command("bind-access", root.path(), &[], &identity().to_string());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        read(root.path())["authentication"]["access"]["ownerSubject"],
        "123456"
    );
    let before = read(root.path());
    let mut wrong = identity();
    wrong["idp"]["type"] = json!("cloudflare");
    assert!(
        !command("bind-access", root.path(), &[], &wrong.to_string())
            .status
            .success()
    );
    assert_eq!(read(root.path()), before);
    assert!(!command(
        "set-password",
        root.path(),
        &["--password-stdin"],
        "synthetic-password"
    )
    .status
    .success());
    assert!(command("unbind-access", root.path(), &[], "")
        .status
        .success());
    assert_eq!(
        read(root.path())["authentication"]["access"]["ownerSubject"],
        Value::Null
    );
    assert!(root.path().join("access-revocations.json").exists());
}

#[test]
fn migrating_preserves_settings_and_retired_hash_but_revokes_legacy_sessions() {
    let root = tempfile::tempdir().unwrap();
    let setup = setup(root.path());
    let settings = root.path().join("gui.json");
    let frontend = root.path().join("frontend");
    std::fs::write(&settings, "{\"theme\":\"dark\"}").unwrap();
    let output = command(
        "init",
        root.path(),
        &[
            "--public-url",
            "https://app.example.test",
            "--settings",
            settings.to_str().unwrap(),
            "--frontend",
            frontend.to_str().unwrap(),
            "--owner",
            "owner",
            "--password-stdin",
        ],
        "synthetic-password",
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let owner = std::fs::read(root.path().join("owner.json")).unwrap();
    std::fs::write(
        root.path().join("sessions.json"),
        "{\"old\":{\"username\":\"owner\",\"csrf\":\"old\",\"expiresAt\":9999999999}}",
    )
    .unwrap();
    let output = command(
        "use-access",
        root.path(),
        &["--access-config", setup.to_str().unwrap()],
        "",
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read(root.path().join("owner.json")).unwrap(),
        owner
    );
    assert_eq!(
        std::fs::read_to_string(&settings).unwrap(),
        "{\"theme\":\"dark\"}"
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("sessions.json")).unwrap(),
        "{}"
    );
    assert_eq!(
        read(root.path())["authentication"]["mode"],
        "cloudflareAccess"
    );
}
