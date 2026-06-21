//! On-disk session + config persistence for the CLI.
//!
//! Everything lives under `~/.tidework/`. The session blob is the same shape the
//! WASM bridge persists, so the two clients stay format-compatible.

use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;

use crate::home_dir;

/// Resolved locations for the CLI's persistent state.
pub struct Paths {
    pub config_dir: PathBuf,
    pub store_dir: PathBuf,
    pub config_file: PathBuf,
    pub session_file: PathBuf,
}

/// What we persist alongside the session blob so a later run knows where to
/// reconnect.
#[derive(serde::Serialize, serde::Deserialize)]
struct StoredConfig {
    homeserver: String,
}

/// A loaded session: the homeserver plus the raw session blob to restore with.
pub struct SavedSession {
    pub homeserver: String,
    pub session: String,
}

impl SavedSession {
    /// Best-effort extraction of the `userId` field from the session blob,
    /// used as a fallback when a live client identity isn't available.
    pub fn user_id(&self) -> Option<String> {
        let v: serde_json::Value = serde_json::from_str(&self.session).ok()?;
        v.get("userId")?.as_str().map(|s| s.to_string())
    }
}

impl Paths {
    pub fn resolve() -> Result<Self> {
        let config_dir = home_dir()?.join(".tidework");
        Ok(Self {
            store_dir: config_dir.join("store"),
            config_file: config_dir.join("config.json"),
            session_file: config_dir.join("session.json"),
            config_dir,
        })
    }

    /// Create the config + store directories if they don't exist.
    pub fn ensure_dirs(&self) -> Result<()> {
        fs::create_dir_all(&self.store_dir)
            .with_context(|| format!("creating {}", self.store_dir.display()))?;
        Ok(())
    }

    /// Persist the homeserver + session blob.
    pub fn save_session(&self, homeserver: &str, session_blob: &str) -> Result<()> {
        self.ensure_dirs()?;
        let config = serde_json::to_string_pretty(&StoredConfig {
            homeserver: homeserver.to_string(),
        })?;
        fs::write(&self.config_file, config)
            .with_context(|| format!("writing {}", self.config_file.display()))?;
        fs::write(&self.session_file, session_blob)
            .with_context(|| format!("writing {}", self.session_file.display()))?;
        Ok(())
    }

    /// Load the saved session, if any.
    pub fn load_session(&self) -> Result<Option<SavedSession>> {
        if !self.session_file.exists() || !self.config_file.exists() {
            return Ok(None);
        }
        let config: StoredConfig = serde_json::from_str(
            &fs::read_to_string(&self.config_file)
                .with_context(|| format!("reading {}", self.config_file.display()))?,
        )
        .context("parsing config.json")?;
        let session = fs::read_to_string(&self.session_file)
            .with_context(|| format!("reading {}", self.session_file.display()))?;
        Ok(Some(SavedSession {
            homeserver: config.homeserver,
            session,
        }))
    }

    /// Remove the saved session, config, and crypto store.
    pub fn clear(&self) -> Result<()> {
        for f in [&self.session_file, &self.config_file] {
            if f.exists() {
                fs::remove_file(f).with_context(|| format!("removing {}", f.display()))?;
            }
        }
        if self.store_dir.exists() {
            fs::remove_dir_all(&self.store_dir)
                .with_context(|| format!("removing {}", self.store_dir.display()))?;
        }
        Ok(())
    }
}
