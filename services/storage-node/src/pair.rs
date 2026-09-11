//! `nodus node pair` — first-time bootstrap pairing over HTTPS (§7b/§7c).
//!
//! The pairing code is a **bootstrap credential only**: redeeming it binds this
//! node's persistent Ed25519 identity to an account on the Relay. After success
//! the relay URL is persisted and the normal `/ws` challenge-response takes
//! over; the code is never needed again and is never stored by the node.
//!
//! The plaintext code is only ever sent in the redeem request body. It is not
//! written to `config.toml`, logged, or retained.

use serde::{Deserialize, Serialize};

use crate::config::{self, Config};
use crate::identity;

/// Open Relay endpoint that consumes a code and registers the node (§7b).
const REDEEM_PATH: &str = "/pairing/codes/redeem";

/// Shown on every pairing failure so an operator whose node rejected auth
/// knows exactly how to recover.
pub const NOT_PAIRED_GUIDANCE: &str = "Storage Node is not paired. Run: `nodus node pair`";

/// Shown when the redeem succeeded but the local config write did not: the relay
/// has already consumed the code, so re-running pairing would only report
/// `code_consumed`. Recover by fixing the config and booting with `--relay`.
const PERSIST_FAILED_GUIDANCE: &str = "The node was registered, but its relay URL could not be saved. Do not re-run \
     pairing (the code is now used); fix ~/.nodus/config.toml and run \
     `nodus node start --relay <url>`.";

/// Shown when the relay URL is plaintext HTTP to a non-loopback host.
const INSECURE_RELAY_GUIDANCE: &str =
    "Re-run `nodus node pair` with the public https:// relay URL.";

#[derive(Serialize)]
struct RedeemRequest<'a> {
    code: &'a str,
    node_id: &'a str,
    public_key: &'a str,
}

#[derive(Deserialize, Debug, Clone)]
struct RedeemResponse {
    status: String,
    account_id: String,
    #[serde(default)]
    is_primary: bool,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: String,
}

/// Every way pairing can fail, with the Relay's machine-readable reason where
/// one exists. Kept typed (rather than strings) so the CLI and tests can match
/// on the exact cause.
#[derive(Debug, PartialEq, Eq)]
pub enum PairError {
    CodeUnknown,
    CodeExpired,
    CodeRevoked,
    CodeConsumed,
    NodeOwnedElsewhere,
    /// The node_id is already registered under this account with a different
    /// Ed25519 key. Key rotation/re-pairing is a v1 non-goal, so the Relay
    /// rejects the registration instead of replacing the key.
    NodeKeyMismatch,
    RateLimited,
    BadRequest(String),
    Server(String),
    Transport(String),
    NoRelay,
    NoCode,
    BadResponse(String),
    /// The configured relay is plaintext HTTP to a non-loopback host, so the
    /// bootstrap credential would cross the network unencrypted.
    InsecureRelay(String),
    /// The code was redeemed but the config write failed (node is registered).
    PersistFailed(String),
    /// Local failure (identity load / config write) before the redeem.
    Internal(String),
}

impl std::fmt::Display for PairError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PairError::CodeUnknown => write!(f, "pairing code is not recognised"),
            PairError::CodeExpired => write!(f, "pairing code has expired"),
            PairError::CodeRevoked => write!(f, "pairing code has been revoked"),
            PairError::CodeConsumed => write!(f, "pairing code has already been used"),
            PairError::NodeOwnedElsewhere => {
                write!(f, "this node is already registered to another account")
            }
            PairError::NodeKeyMismatch => write!(
                f,
                "this node id is already registered with a different key; \
                 key rotation is not supported in v1"
            ),
            PairError::RateLimited => {
                write!(f, "too many pairing attempts; wait and try again")
            }
            PairError::BadRequest(reason) => write!(f, "relay rejected the request: {reason}"),
            PairError::Server(reason) => write!(f, "relay error: {reason}"),
            PairError::Transport(e) => write!(f, "could not reach the relay: {e}"),
            PairError::NoRelay => write!(
                f,
                "no relay configured; pass --relay, set NODUS_RELAY_URL, \
                 or configure relay_url"
            ),
            PairError::NoCode => write!(f, "no pairing code provided; pass --code"),
            PairError::BadResponse(e) => write!(f, "unexpected relay response: {e}"),
            PairError::InsecureRelay(host) => write!(
                f,
                "refusing to send the pairing code over plain HTTP to {host}; \
                 use an https:// relay URL (localhost is exempt for development)"
            ),
            PairError::PersistFailed(e) => {
                write!(f, "node registered, but saving the relay URL failed: {e}")
            }
            PairError::Internal(e) => write!(f, "pairing failed locally: {e}"),
        }
    }
}

impl std::error::Error for PairError {}

impl PairError {
    /// Recovery guidance printed alongside the reason (§7b "Unpaired-node UX").
    /// Most failures leave the node unpaired, so the default points at
    /// `nodus node pair`; the two local/transport cases need different advice.
    pub fn guidance(&self) -> &'static str {
        match self {
            PairError::PersistFailed(_) => PERSIST_FAILED_GUIDANCE,
            PairError::InsecureRelay(_) => INSECURE_RELAY_GUIDANCE,
            _ => NOT_PAIRED_GUIDANCE,
        }
    }
}

/// Reject a non-loopback plaintext relay: the pairing code is a bootstrap
/// credential and must not cross the network unencrypted (§7b). Loopback is
/// exempt so a local dev relay (`http://127.0.0.1:8080`, `http://localhost:8080`,
/// `http://[::1]:8080`) keeps working. Unparseable values are passed through so
/// they fail on connection rather than being mislabelled as insecure.
fn ensure_secure_transport(base: &str) -> Result<(), PairError> {
    let Ok(url) = url::Url::parse(base) else {
        return Ok(());
    };
    let loopback = match url.host() {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    };
    if url.scheme() == "http" && !loopback {
        return Err(PairError::InsecureRelay(
            url.host_str().unwrap_or(base).to_string(),
        ));
    }
    Ok(())
}

/// Interactive input, abstracted so the flow can be tested without a TTY.
pub trait Prompter {
    /// Prompt for the relay URL, offering `default` (already-configured URL).
    fn relay_url(&mut self, default: Option<&str>) -> anyhow::Result<String>;
    /// Prompt for the pairing code.
    fn code(&mut self) -> anyhow::Result<String>;
}

/// Real prompt backed by `dialoguer`, mirroring `config::prompt`.
pub struct DialoguerPrompt;

impl Prompter for DialoguerPrompt {
    fn relay_url(&mut self, default: Option<&str>) -> anyhow::Result<String> {
        let mut input = dialoguer::Input::new().with_prompt("Relay URL");
        if let Some(default) = default {
            input = input.default(default.to_string());
        }
        let value: String = input
            .interact_text()
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        Ok(value.trim().to_string())
    }

    fn code(&mut self) -> anyhow::Result<String> {
        let value: String = dialoguer::Input::new()
            .with_prompt("Pairing code")
            .interact_text()
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        Ok(value.trim().to_string())
    }
}

/// Result of a successful redeem, returned to the caller so it can boot the
/// daemon against the freshly-paired relay.
#[derive(Debug)]
pub struct PairOutcome {
    pub account_id: String,
    pub is_primary: bool,
    pub relay_base: String,
    pub node_id: String,
}

/// POST `{base}/pairing/codes/redeem` and translate the relay's HTTP status +
/// JSON error body into a typed `PairError`.
pub async fn redeem(
    base: &str,
    code: &str,
    node_id: &str,
    public_key_hex: &str,
    http: &reqwest::Client,
) -> Result<(String, bool), PairError> {
    let url = format!("{}{}", base.trim_end_matches('/'), REDEEM_PATH);
    let resp = http
        .post(&url)
        .json(&RedeemRequest {
            code,
            node_id,
            public_key: public_key_hex,
        })
        .send()
        .await
        .map_err(|e| PairError::Transport(e.to_string()))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| PairError::Transport(e.to_string()))?;

    if status.is_success() {
        let parsed: RedeemResponse =
            serde_json::from_str(&body).map_err(|e| PairError::BadResponse(e.to_string()))?;
        if parsed.status != "ok" {
            return Err(PairError::BadResponse(format!(
                "expected status \"ok\", got {:?}",
                parsed.status
            )));
        }
        return Ok((parsed.account_id, parsed.is_primary));
    }

    // Non-2xx: the relay returns `{"error":"<machine-readable reason>"}`.
    let reason = serde_json::from_str::<ErrorBody>(&body)
        .map(|e| e.error)
        .unwrap_or(body);
    Err(match (status.as_u16(), reason.as_str()) {
        (404, "code_unknown") => PairError::CodeUnknown,
        (410, "code_expired") => PairError::CodeExpired,
        (410, "code_revoked") => PairError::CodeRevoked,
        (409, "code_consumed") => PairError::CodeConsumed,
        (409, "node_owned_elsewhere") => PairError::NodeOwnedElsewhere,
        (409, "node_key_mismatch") => PairError::NodeKeyMismatch,
        (429, _) => PairError::RateLimited,
        (400, _) => PairError::BadRequest(reason),
        (s, _) if s >= 500 => PairError::Server(reason),
        _ => PairError::BadResponse(format!("HTTP {}: {reason}", status.as_u16())),
    })
}

/// Resolve relay + code, load the persistent identity, redeem, and persist the
/// relay URL **only on success**. Returns the account binding for the caller to
/// report and to boot the daemon against.
pub async fn run(
    cfg: &Config,
    cli_relay: Option<String>,
    cli_code: Option<String>,
    interactive: bool,
    prompter: &mut dyn Prompter,
    http: &reqwest::Client,
) -> Result<PairOutcome, PairError> {
    // Relay: CLI `--relay` wins; otherwise prompt (interactive) with the
    // already-configured/env URL as default; otherwise use the configured value.
    let relay_raw = match cli_relay.filter(|r| !r.trim().is_empty()) {
        Some(r) => r,
        None if interactive => prompter
            .relay_url(cfg.relay_url.as_deref())
            .map_err(|e| PairError::Internal(e.to_string()))?,
        None => cfg.relay_url.clone().ok_or(PairError::NoRelay)?,
    };
    let relay_base = crate::sync::client::relay_http_base(&relay_raw);
    // Fail before touching the network/identity if the code would cross the
    // network in cleartext to a non-loopback host.
    ensure_secure_transport(&relay_base)?;

    let code = match cli_code.filter(|c| !c.trim().is_empty()) {
        Some(c) => c.trim().to_string(),
        None if interactive => prompter
            .code()
            .map_err(|e| PairError::Internal(e.to_string()))?,
        None => return Err(PairError::NoCode),
    };

    // Reuse the persistent identity — never regenerate per attempt (§7b).
    let identity = identity::load_or_generate(&cfg.nodus_dir)
        .map_err(|e| PairError::Internal(e.to_string()))?;
    let public_key = hex::encode(identity.public_key.to_bytes());

    let (account_id, is_primary) =
        redeem(&relay_base, &code, &identity.node_id, &public_key, http).await?;

    // Persist only after the relay confirmed registration (§11a), so an
    // unpaired node never records a relay it has not proven. A failure here is
    // distinct: the relay has already consumed the code, so the node is
    // registered even though the local write failed.
    config::persist_relay_url(&cfg.nodus_dir, &cfg.data_dir, &relay_base)
        .map_err(|e| PairError::PersistFailed(e.to_string()))?;

    Ok(PairOutcome {
        account_id,
        is_primary,
        relay_base,
        node_id: identity.node_id.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::NodusConfigFile;
    use std::fs;
    use tempfile::tempdir;

    /// Spawn a one-route mock relay returning a fixed status + body, and
    /// return its base URL.
    async fn spawn_mock_relay(status: u16, body: &'static str) -> String {
        use axum::Router;
        use axum::http::StatusCode;
        use axum::routing::post;

        let app = Router::new().route(
            REDEEM_PATH,
            post(move || async move { (StatusCode::from_u16(status).unwrap(), body) }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{addr}")
    }

    fn test_config(dir: &std::path::Path, relay: Option<&str>) -> Config {
        Config {
            data_dir: dir.join("data"),
            nodus_dir: dir.join(".nodus"),
            relay_url: relay.map(str::to_string),
        }
    }

    fn read_config(nodus_dir: &std::path::Path) -> Option<NodusConfigFile> {
        let path = nodus_dir.join(config::CONFIG_FILE);
        if !path.exists() {
            return None;
        }
        Some(toml::from_str(&fs::read_to_string(path).unwrap()).unwrap())
    }

    #[derive(Default)]
    struct FakePrompter {
        relay: Option<String>,
        code: Option<String>,
        relay_default_seen: Option<Option<String>>,
    }

    impl Prompter for FakePrompter {
        fn relay_url(&mut self, default: Option<&str>) -> anyhow::Result<String> {
            self.relay_default_seen = Some(default.map(str::to_string));
            Ok(self.relay.clone().unwrap_or_default())
        }
        fn code(&mut self) -> anyhow::Result<String> {
            Ok(self.code.clone().unwrap_or_default())
        }
    }

    #[tokio::test]
    async fn redeem_success_returns_account() {
        let base = spawn_mock_relay(
            200,
            r#"{"status":"ok","account_id":"acct-1","is_primary":true}"#,
        )
        .await;
        let (account, primary) = redeem(
            &base,
            "NODUS-ABCD-2345",
            "node-1",
            &"ab".repeat(32),
            &reqwest::Client::new(),
        )
        .await
        .unwrap();
        assert_eq!(account, "acct-1");
        assert!(primary);
    }

    #[tokio::test]
    async fn redeem_maps_each_failure_reason() {
        type Case = (u16, &'static str, fn(PairError) -> bool);
        let cases: &[Case] = &[
            (404, r#"{"error":"code_unknown"}"#, |e| {
                e == PairError::CodeUnknown
            }),
            (410, r#"{"error":"code_expired"}"#, |e| {
                e == PairError::CodeExpired
            }),
            (410, r#"{"error":"code_revoked"}"#, |e| {
                e == PairError::CodeRevoked
            }),
            (409, r#"{"error":"code_consumed"}"#, |e| {
                e == PairError::CodeConsumed
            }),
            (409, r#"{"error":"node_owned_elsewhere"}"#, |e| {
                e == PairError::NodeOwnedElsewhere
            }),
            (409, r#"{"error":"node_key_mismatch"}"#, |e| {
                e == PairError::NodeKeyMismatch
            }),
            (429, r#"{"error":"rate_limit_exceeded"}"#, |e| {
                e == PairError::RateLimited
            }),
            (400, r#"{"error":"invalid node_id format"}"#, |e| {
                matches!(e, PairError::BadRequest(_))
            }),
            (500, r#"{"error":"failed to register node"}"#, |e| {
                matches!(e, PairError::Server(_))
            }),
        ];

        for (status, body, matches_fn) in cases {
            let base = spawn_mock_relay(*status, body).await;
            let err = redeem(
                &base,
                "NODUS-ABCD-2345",
                "node-1",
                &"ab".repeat(32),
                &reqwest::Client::new(),
            )
            .await
            .unwrap_err();
            assert!(matches_fn(err), "status {status} body {body} mapped wrong");
        }
    }

    #[tokio::test]
    async fn redeem_transport_error_on_dead_relay() {
        // Nothing is listening on this port.
        let err = redeem(
            "http://127.0.0.1:1",
            "NODUS-ABCD-2345",
            "node-1",
            &"ab".repeat(32),
            &reqwest::Client::new(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PairError::Transport(_)));
    }

    #[test]
    fn secure_transport_allows_https_and_loopback_http() {
        assert!(ensure_secure_transport("https://nodus.example.com").is_ok());
        assert!(ensure_secure_transport("http://localhost:8080").is_ok());
        assert!(ensure_secure_transport("http://127.0.0.1:8080").is_ok());
        assert!(ensure_secure_transport("http://[::1]:8080").is_ok());
    }

    #[test]
    fn secure_transport_rejects_public_plaintext() {
        assert!(matches!(
            ensure_secure_transport("http://nodus.example.com").unwrap_err(),
            PairError::InsecureRelay(_)
        ));
    }

    #[test]
    fn guidance_is_tailored_for_local_failures() {
        assert_eq!(
            PairError::InsecureRelay("host".into()).guidance(),
            INSECURE_RELAY_GUIDANCE
        );
        assert_eq!(
            PairError::PersistFailed("disk".into()).guidance(),
            PERSIST_FAILED_GUIDANCE
        );
        assert_eq!(PairError::CodeConsumed.guidance(), NOT_PAIRED_GUIDANCE);
    }

    #[tokio::test]
    async fn run_rejects_plaintext_public_relay_before_network() {
        let dir = tempdir().unwrap();
        let cfg = test_config(dir.path(), None);
        let mut prompt = FakePrompter::default();
        let err = run(
            &cfg,
            Some("http://nodus.example.com".into()),
            Some("NODUS-ABCD-2345".into()),
            false,
            &mut prompt,
            &reqwest::Client::new(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PairError::InsecureRelay(_)));
        // Rejected before generating an identity or touching the relay.
        assert!(!cfg.nodus_dir.join(config::IDENTITY_DIR).exists());
    }

    #[tokio::test]
    async fn run_success_persists_relay_and_returns_account() {
        let base = spawn_mock_relay(200, r#"{"status":"ok","account_id":"acct-9"}"#).await;
        let dir = tempdir().unwrap();
        let cfg = test_config(dir.path(), None);
        let mut prompt = FakePrompter::default();

        let outcome = run(
            &cfg,
            Some(base.clone()),
            Some("NODUS-ABCD-2345".into()),
            false,
            &mut prompt,
            &reqwest::Client::new(),
        )
        .await
        .unwrap();

        assert_eq!(outcome.account_id, "acct-9");
        assert!(!outcome.is_primary);
        let saved = read_config(&cfg.nodus_dir).expect("config written on success");
        assert_eq!(saved.relay_url.as_deref(), Some(base.as_str()));
        assert_eq!(saved.data_dir, cfg.data_dir);
    }

    #[tokio::test]
    async fn run_failure_does_not_persist_and_leaves_config_untouched() {
        let base = spawn_mock_relay(409, r#"{"error":"code_consumed"}"#).await;
        let dir = tempdir().unwrap();
        let cfg = test_config(dir.path(), None);
        let mut prompt = FakePrompter::default();

        let err = run(
            &cfg,
            Some(base),
            Some("NODUS-ABCD-2345".into()),
            false,
            &mut prompt,
            &reqwest::Client::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(err, PairError::CodeConsumed);
        assert!(
            read_config(&cfg.nodus_dir).is_none(),
            "a rejected pairing must not write relay_url"
        );
        assert_eq!(err.guidance(), NOT_PAIRED_GUIDANCE);
    }

    #[tokio::test]
    async fn run_persists_exactly_once_across_attempts() {
        let ok = spawn_mock_relay(200, r#"{"status":"ok","account_id":"acct-1"}"#).await;
        let dir = tempdir().unwrap();
        let cfg = test_config(dir.path(), None);
        let mut prompt = FakePrompter::default();

        run(
            &cfg,
            Some(ok.clone()),
            Some("NODUS-ABCD-2345".into()),
            false,
            &mut prompt,
            &reqwest::Client::new(),
        )
        .await
        .unwrap();
        let after_success = fs::read(cfg.nodus_dir.join(config::CONFIG_FILE)).unwrap();

        // A later failing attempt must not rewrite the persisted config.
        let bad = spawn_mock_relay(410, r#"{"error":"code_expired"}"#).await;
        let _ = run(
            &cfg,
            Some(bad),
            Some("NODUS-ABCD-2345".into()),
            false,
            &mut prompt,
            &reqwest::Client::new(),
        )
        .await;
        let after_failure = fs::read(cfg.nodus_dir.join(config::CONFIG_FILE)).unwrap();
        assert_eq!(
            after_success, after_failure,
            "config must be written once, on success only"
        );
    }

    #[tokio::test]
    async fn identity_is_reused_across_attempts() {
        let dir = tempdir().unwrap();
        let cfg = test_config(dir.path(), None);
        let mut prompt = FakePrompter::default();
        let bad = spawn_mock_relay(404, r#"{"error":"code_unknown"}"#).await;

        for _ in 0..2 {
            let err = run(
                &cfg,
                Some(bad.clone()),
                Some("NODUS-ABCD-2345".into()),
                false,
                &mut prompt,
                &reqwest::Client::new(),
            )
            .await
            .unwrap_err();
            assert_eq!(err, PairError::CodeUnknown);
        }

        // The first attempt generates the keypair once; the second must not.
        let key_path = cfg
            .nodus_dir
            .join(config::IDENTITY_DIR)
            .join("node_private_key");
        let node_id_path = cfg.nodus_dir.join(config::IDENTITY_DIR).join("node_id");
        let first_key = fs::read(&key_path).unwrap();
        let first_id = fs::read_to_string(&node_id_path).unwrap();

        let err = run(
            &cfg,
            Some(spawn_mock_relay(404, r#"{"error":"code_unknown"}"#).await),
            Some("NODUS-ABCD-2345".into()),
            false,
            &mut prompt,
            &reqwest::Client::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(err, PairError::CodeUnknown);
        assert_eq!(fs::read(&key_path).unwrap(), first_key);
        assert_eq!(fs::read_to_string(&node_id_path).unwrap(), first_id);
    }

    #[tokio::test]
    async fn interactive_prompts_for_relay_and_code_with_configured_default() {
        let base = spawn_mock_relay(200, r#"{"status":"ok","account_id":"acct-7"}"#).await;
        let dir = tempdir().unwrap();
        let cfg = test_config(dir.path(), Some("https://configured.example"));
        let mut prompt = FakePrompter {
            relay: Some(base.clone()),
            code: Some("NODUS-ABCD-2345".into()),
            relay_default_seen: None,
        };

        let outcome = run(&cfg, None, None, true, &mut prompt, &reqwest::Client::new())
            .await
            .unwrap();

        assert_eq!(outcome.account_id, "acct-7");
        assert_eq!(
            prompt.relay_default_seen,
            Some(Some("https://configured.example".to_string())),
            "prompt must be offered the already-configured URL as default"
        );
        assert_eq!(
            read_config(&cfg.nodus_dir).unwrap().relay_url.as_deref(),
            Some(base.as_str())
        );
    }

    #[tokio::test]
    async fn non_interactive_without_relay_or_code_errors() {
        let dir = tempdir().unwrap();
        let cfg = test_config(dir.path(), None);
        let mut prompt = FakePrompter::default();

        let no_relay = run(
            &cfg,
            None,
            Some("NODUS-ABCD-2345".into()),
            false,
            &mut prompt,
            &reqwest::Client::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(no_relay, PairError::NoRelay);

        let no_code = run(
            &cfg,
            Some("https://nodus.example.com".into()),
            None,
            false,
            &mut prompt,
            &reqwest::Client::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(no_code, PairError::NoCode);
    }
}
