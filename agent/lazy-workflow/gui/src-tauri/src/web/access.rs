//! Access assertions are credentials, never identity headers. Resolve the IdP's
//! subject through the pinned Access identity endpoint after verifying the JWT.
use super::auth::now;
use anyhow::{ensure, Result};
use axum::http::{header, HeaderMap, StatusCode};
use jsonwebtoken::{
    decode, decode_header,
    jwk::{JwkSet, KeyAlgorithm, KeyOperations, PublicKeyUse},
    Algorithm, DecodingKey, Validation,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub issuer: String,
    pub audience: String,
    pub account_id: String,
    pub github_idp_id: String,
    /// Set only by the local operator from the verified Access identity response.
    #[serde(default)]
    pub owner_subject: Option<String>,
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        let url = url::Url::parse(&self.issuer)?;
        let host = url.host_str().unwrap_or_default();
        let team = host
            .strip_suffix(".cloudflareaccess.com")
            .unwrap_or_default();
        ensure!(
            url.scheme() == "https"
                && host.ends_with(".cloudflareaccess.com")
                && (1..=63).contains(&team.len())
                && team
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                && !team.starts_with('-')
                && !team.ends_with('-')
                && url.port().is_none()
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none()
                && url.origin().ascii_serialization() == self.issuer,
            "invalid Access issuer: use the exact HTTPS Cloudflare team origin"
        );
        ensure!(
            hex_id(&self.audience, 64)
                && hex_id(&self.account_id, 32)
                && canonical_uuid(&self.github_idp_id),
            "invalid Access audience, account or GitHub identity provider"
        );
        ensure!(
            self.owner_subject.as_ref().is_none_or(|id| provider_id(id)),
            "invalid owner provider subject"
        );
        Ok(())
    }
}
fn hex_id(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|c| c.is_ascii_hexdigit())
}
pub(super) fn canonical_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
fn provider_id(value: &str) -> bool {
    (1..=256).contains(&value.len())
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub issuer: String,
    pub idp_id: String,
    /// The IdP subject returned as `id` by Access get-identity, not email or JWT sub.
    pub provider_user_id: String,
}
impl Binding {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            canonical_uuid(&self.idp_id) && provider_id(&self.provider_user_id),
            "invalid Access identity binding"
        );
        // Reuse the issuer validation without accepting a caller-selected endpoint.
        Config {
            issuer: self.issuer.clone(),
            audience: "0".repeat(64),
            account_id: "0".repeat(32),
            github_idp_id: self.idp_id.clone(),
            owner_subject: None,
        }
        .validate()
    }
}

#[derive(Deserialize)]
pub struct Identity {
    #[serde(deserialize_with = "deserialize_provider_subject")]
    pub id: String,
    pub user_uuid: String,
    pub account_id: String,
    idp: IdentityProvider,
}
fn deserialize_provider_subject<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<String, D::Error> {
    match serde_json::Value::deserialize(deserializer)? {
        serde_json::Value::String(id) => Ok(id),
        value => value
            .as_u64()
            .filter(|id| *id > 0)
            .map(|id| id.to_string())
            .ok_or_else(|| {
                serde::de::Error::custom("expected a provider subject string or positive integer")
            }),
    }
}
#[derive(Deserialize)]
pub(super) struct IdentityProvider {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
}
impl Identity {
    pub fn binding(&self, config: &Config) -> Result<Binding> {
        ensure!(
            self.account_id == config.account_id
                && canonical_uuid(&self.user_uuid)
                && self.idp.kind == "github"
                && self.idp.id == config.github_idp_id
                && provider_id(&self.id),
            "identity is not from the configured GitHub login provider"
        );
        let binding = Binding {
            issuer: config.issuer.clone(),
            idp_id: self.idp.id.clone(),
            provider_user_id: self.id.clone(),
        };
        binding.validate()?;
        Ok(binding)
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Verified {
    pub binding: Binding,
    pub subject: String,
    pub token_hash: String,
    pub expires_at: u64,
    pub issued_at: u64,
}
#[derive(Deserialize)]
struct Claims {
    sub: String,
    exp: u64,
    iat: u64,
    #[serde(rename = "type")]
    kind: String,
    identity_nonce: String,
}
struct Keys {
    set: JwkSet,
    refreshed: Option<Instant>,
    attempted: Option<Instant>,
}
pub(super) struct Verifier {
    config: Config,
    client: reqwest::Client,
    keys_url: String,
    identity_url: String,
    keys: Mutex<Keys>,
    // Cache only positive identities for this exact assertion, at most 30 seconds.
    // Never use an email, Access sub or identity_nonce as a cross-token cache key.
    identities: Mutex<HashMap<String, (Verified, Instant)>>,
    requests: Semaphore,
}
impl Verifier {
    pub fn new(config: Config) -> Result<Self> {
        config.validate()?;
        Ok(Self {
            keys_url: format!("{}/cdn-cgi/access/certs", config.issuer),
            identity_url: format!("{}/cdn-cgi/access/get-identity", config.issuer),
            config,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(8))
                .build()?,
            keys: Mutex::new(Keys {
                set: JwkSet { keys: vec![] },
                refreshed: None,
                attempted: None,
            }),
            identities: Mutex::new(HashMap::new()),
            requests: Semaphore::new(16),
        })
    }
    async fn key(&self, kid: &str) -> std::result::Result<DecodingKey, StatusCode> {
        let mut keys = self.keys.lock().await;
        let expired = keys
            .refreshed
            .is_none_or(|time| time.elapsed() >= Duration::from_secs(300));
        let unknown = keys.set.find(kid).is_none();
        if expired || unknown {
            if keys
                .attempted
                .is_some_and(|time| time.elapsed() < Duration::from_secs(30))
            {
                return Err(if expired {
                    StatusCode::SERVICE_UNAVAILABLE
                } else {
                    StatusCode::UNAUTHORIZED
                });
            }
            // A failed refresh never extends trust in stale keys. Rate-limit retries.
            keys.attempted = Some(Instant::now());
            let response = self
                .client
                .get(&self.keys_url)
                .send()
                .await
                .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
            let set: JwkSet = bounded_json(response).await?;
            if set.keys.is_empty() || set.keys.len() > 16 {
                return Err(StatusCode::SERVICE_UNAVAILABLE);
            }
            keys.set = set;
            keys.refreshed = Some(Instant::now());
        }
        let key = keys.set.find(kid).ok_or(StatusCode::UNAUTHORIZED)?;
        if keys
            .set
            .keys
            .iter()
            .filter(|key| key.common.key_id.as_deref() == Some(kid))
            .count()
            != 1
            || key
                .common
                .key_algorithm
                .is_some_and(|alg| alg != KeyAlgorithm::RS256)
            || key
                .common
                .public_key_use
                .as_ref()
                .is_some_and(|use_| *use_ != PublicKeyUse::Signature)
            || key
                .common
                .key_operations
                .as_ref()
                .is_some_and(|ops| ops.as_slice() != [KeyOperations::Verify])
        {
            return Err(StatusCode::UNAUTHORIZED);
        }
        DecodingKey::from_jwk(key).map_err(|_| StatusCode::UNAUTHORIZED)
    }
    pub async fn verify(&self, headers: &HeaderMap) -> std::result::Result<Verified, StatusCode> {
        let _permit = self
            .requests
            .try_acquire()
            .map_err(|_| StatusCode::TOO_MANY_REQUESTS)?;
        let mut values = headers.get_all("cf-access-jwt-assertion").iter();
        let token = values
            .next()
            .and_then(|v| v.to_str().ok())
            .ok_or(StatusCode::UNAUTHORIZED)?;
        if values.next().is_some()
            || token.len() > 16_384
            || token.is_empty()
            || !token
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        {
            return Err(StatusCode::UNAUTHORIZED);
        }
        let header = decode_header(token).map_err(|_| StatusCode::UNAUTHORIZED)?;
        if header.alg != Algorithm::RS256 {
            return Err(StatusCode::UNAUTHORIZED);
        }
        let kid = header
            .kid
            .filter(|kid| provider_id(kid))
            .ok_or(StatusCode::UNAUTHORIZED)?;
        let key = self.key(&kid).await?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[&self.config.issuer]);
        validation.set_audience(&[&self.config.audience]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub", "iat", "nbf"]);
        validation.validate_nbf = true;
        validation.leeway = 0;
        let claims = decode::<Claims>(token, &key, &validation)
            .map_err(|_| StatusCode::UNAUTHORIZED)?
            .claims;
        if !canonical_uuid(&claims.sub)
            || claims.kind != "app"
            || !provider_id(&claims.identity_nonce)
            || claims.iat > now()
            || claims.exp <= now()
            || claims.iat >= claims.exp
        {
            return Err(StatusCode::UNAUTHORIZED);
        }
        let token_hash = format!("{:x}", Sha256::digest(token.as_bytes()));
        {
            let mut identities = self.identities.lock().await;
            identities.retain(|_, (identity, time)| {
                time.elapsed() < Duration::from_secs(30) && identity.expires_at > now()
            });
            if let Some((identity, _)) = identities.get(&token_hash) {
                return Ok(identity.clone());
            }
        }
        let response = self
            .client
            .get(&self.identity_url)
            // Only this verified assertion is sent; no browser cookies or API tokens.
            .header(header::COOKIE, format!("CF_Authorization={token}"))
            .send()
            .await
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        let identity: Identity = bounded_json(response).await?;
        if identity.user_uuid != claims.sub {
            return Err(StatusCode::UNAUTHORIZED);
        }
        let verified = Verified {
            binding: identity
                .binding(&self.config)
                .map_err(|_| StatusCode::UNAUTHORIZED)?,
            subject: claims.sub,
            token_hash,
            expires_at: claims.exp,
            issued_at: claims.iat,
        };
        let mut identities = self.identities.lock().await;
        if identities.len() < 1000 {
            identities.insert(
                verified.token_hash.clone(),
                (verified.clone(), Instant::now()),
            );
        }
        Ok(verified)
    }
    pub fn owns(&self, verified: &Verified) -> bool {
        self.config.owner_subject.as_ref() == Some(&verified.binding.provider_user_id)
            && verified.binding.issuer == self.config.issuer
            && verified.binding.idp_id == self.config.github_idp_id
    }
    #[cfg(test)]
    pub(super) fn set_test_owner(&mut self, subject: Option<String>) {
        self.config.owner_subject = subject;
    }
}
async fn bounded_json<T: serde::de::DeserializeOwned>(
    mut response: reqwest::Response,
) -> std::result::Result<T, StatusCode> {
    if !response.status().is_success() {
        return Err(if matches!(response.status().as_u16(), 401 | 403) {
            StatusCode::UNAUTHORIZED
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        });
    }
    if response.content_length().is_some_and(|len| len > 65_536) {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
    {
        if bytes.len() + chunk.len() > 65_536 {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| StatusCode::SERVICE_UNAVAILABLE)
}

#[cfg(test)]
pub(super) mod tests;
