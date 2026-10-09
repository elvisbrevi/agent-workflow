use super::config::private_write;
use argon2::{password_hash::SaltString, Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const COOKIE: &str = "__Host-lz-session";

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn digest(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}
pub fn equal(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Owner {
    pub username: String,
    pub password_hash: String,
}
impl Owner {
    pub fn create(username: String, password: &str) -> Result<Self, String> {
        if username.is_empty()
            || username.len() > 80
            || !username
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-@".contains(&b))
        {
            return Err("owner must be 1..80 letters, digits or ._-@".into());
        }
        if password.len() < 12 || password.len() > 1024 {
            return Err("password must contain 12..1024 bytes".into());
        }
        let salt = SaltString::generate(&mut OsRng);
        let password_hash = Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map_err(|e| e.to_string())?
            .to_string();
        Ok(Self {
            username,
            password_hash,
        })
    }
    pub fn verify(&self, username: &str, password: &str) -> bool {
        // Verify even for an unknown username; login failures have the same response.
        let verified = PasswordHash::new(&self.password_hash)
            .ok()
            .is_some_and(|hash| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &hash)
                    .is_ok()
            });
        equal(username, &self.username) && verified
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub username: String,
    pub csrf: String,
    pub expires_at: u64,
    #[serde(default)]
    pub(super) access: Option<super::access::Verified>,
}
impl Session {
    pub fn public(&self) -> serde_json::Value {
        serde_json::json!({"username":self.username,"csrf":self.csrf,"expiresAt":self.expires_at})
    }
}

pub struct Sessions {
    path: PathBuf,
    entries: BTreeMap<String, Session>,
}
impl Sessions {
    pub fn load(path: PathBuf) -> Result<Self, String> {
        let entries = if path.exists() {
            serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("invalid sessions file: {e}"))?
        } else {
            BTreeMap::new()
        };
        let mut sessions = Self { path, entries };
        sessions.entries.retain(|_, s| s.expires_at > now());
        Ok(sessions)
    }
    pub fn create(&mut self, username: &str, seconds: u64) -> Result<(String, Session), String> {
        self.create_bound(username, seconds, None)
    }
    pub(super) fn create_bound(
        &mut self,
        username: &str,
        seconds: u64,
        access: Option<super::access::Verified>,
    ) -> Result<(String, Session), String> {
        self.entries.retain(|_, s| s.expires_at > now());
        if self.entries.len() >= 32 {
            return Err("too many active sessions; revoke sessions locally".into());
        }
        let token = random_token();
        let session = Session {
            username: username.into(),
            csrf: random_token(),
            expires_at: now() + seconds,
            access,
        };
        self.entries.insert(digest(&token), session.clone());
        if let Err(error) = private_write(&self.path, &self.entries) {
            self.entries.remove(&digest(&token));
            return Err(error);
        }
        Ok((token, session))
    }
    pub fn get(&self, token: &str) -> Option<Session> {
        if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        self.entries
            .get(&digest(token))
            .filter(|s| s.expires_at > now())
            .cloned()
    }
    pub fn revoke(&mut self, token: &str) -> Result<(), String> {
        self.entries.remove(&digest(token));
        private_write(&self.path, &self.entries)
    }
    pub fn revoke_all(path: &Path) -> Result<(), String> {
        private_write(path, &BTreeMap::<String, Session>::new())
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessRevocations {
    not_before: u64,
    tokens: BTreeMap<String, u64>,
}
impl AccessRevocations {
    pub fn load(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Ok(Self::default());
        }
        serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    }
    pub(super) fn permits(&self, verified: &super::access::Verified) -> bool {
        verified.issued_at > self.not_before && !self.tokens.contains_key(&verified.token_hash)
    }
    pub(super) fn revoke(
        &mut self,
        path: &Path,
        verified: &super::access::Verified,
    ) -> Result<(), String> {
        self.tokens.retain(|_, exp| *exp > now());
        if self.tokens.len() >= 4096 {
            return Err("too many revoked assertions; retry after expiration".into());
        }
        self.tokens
            .insert(verified.token_hash.clone(), verified.expires_at);
        private_write(path, self)
    }
    pub fn revoke_all(path: &Path) -> Result<(), String> {
        let mut revocations = Self::load(path)?;
        revocations.not_before = now();
        private_write(path, &revocations)
    }
}

pub fn cookie(token: &str, max_age: u64) -> String {
    format!("{COOKIE}={token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age={max_age}")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_access_revocation_persists_the_cutoff_and_requires_a_new_assertion() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("access-revocations.json");
        let mut verified = super::super::access::Verified {
            binding: super::super::access::Binding {
                issuer: "https://synthetic.cloudflareaccess.com".into(),
                idp_id: "f43dbf29-6f6b-4f38-ac06-d8a973fb4e47".into(),
                provider_user_id: "123456".into(),
            },
            subject: "2f102676-72cd-4d60-9f49-a94a33f9b231".into(),
            token_hash: "synthetic-old-assertion".into(),
            issued_at: now() - 1,
            expires_at: now() + 60,
        };
        assert!(AccessRevocations::load(&path).unwrap().permits(&verified));
        AccessRevocations::revoke_all(&path).unwrap();
        let mut loaded = AccessRevocations::load(&path).unwrap();
        assert!(!loaded.permits(&verified));
        // The verifier separately rejects future iat. This unit checks the persisted cutoff boundary.
        verified.issued_at = loaded.not_before;
        assert!(!loaded.permits(&verified));
        verified.issued_at += 1;
        verified.token_hash = "synthetic-new-assertion".into();
        assert!(loaded.permits(&verified));
        loaded.revoke(&path, &verified).unwrap();
        assert!(!AccessRevocations::load(&path).unwrap().permits(&verified));
    }
    #[test]
    fn sessions_survive_restart_expire_revoke_and_do_not_cross_instances() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let path = a.path().join("sessions.json");
        let mut sessions = Sessions::load(path.clone()).unwrap();
        let (token, _) = sessions.create("alice", 60).unwrap();
        assert!(!std::fs::read_to_string(&path).unwrap().contains(&token));
        drop(sessions);
        let mut sessions = Sessions::load(path).unwrap();
        assert_eq!(sessions.get(&token).unwrap().username, "alice");
        assert!(Sessions::load(b.path().join("sessions.json"))
            .unwrap()
            .get(&token)
            .is_none());
        sessions
            .entries
            .get_mut(&digest(&token))
            .unwrap()
            .expires_at = now() - 1;
        assert!(sessions.get(&token).is_none());
        let (token, _) = sessions.create("alice", 60).unwrap();
        sessions.revoke(&token).unwrap();
        assert!(sessions.get(&token).is_none());
    }
    #[test]
    fn password_is_argon2id_and_wrong_credentials_fail() {
        let owner = Owner::create("alice".into(), "synthetic-passphrase").unwrap();
        assert!(owner.password_hash.starts_with("$argon2id$"));
        assert!(owner.verify("alice", "synthetic-passphrase"));
        assert!(!owner.verify("bob", "synthetic-passphrase"));
        assert!(!owner.verify("alice", "wrong"));
    }
}
