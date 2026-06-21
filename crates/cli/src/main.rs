//! `tidework` — a native CLI for the TideWork E2E-encrypted collaborative table
//! app. It reuses the same Rust core as the WASM UI (`app-core` +
//! `tables-over-matrix`) so it can dogfood real workspaces without a browser:
//! log in (password now, MAS/OAuth later), then drive workspace/table/row/cell
//! CRUD and run benchmarks straight against a homeserver.
//!
//! Session state lives under `~/.tidework/`:
//!   - `config.json`  — the homeserver URL
//!   - `session.json` — the saved session blob (token/device), bridge-compatible
//!   - `store/`       — the persistent SQLite crypto store (device + Megolm keys)
//!
//! The crypto store is what lets the CLI decrypt existing encrypted workspaces
//! across runs without re-verifying the device every time.

use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use tables_over_matrix::MatrixClient;

mod session;

#[derive(Parser)]
#[command(
    name = "tidework",
    about = "Native CLI for TideWork encrypted collaborative tables",
    version
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Log in to a homeserver with a username + password and persist the session.
    Login {
        /// Homeserver URL, e.g. https://tidework.io
        #[arg(long)]
        homeserver: String,
        /// Username (localpart or full @user:server).
        #[arg(long)]
        user: String,
        /// Password. If omitted, read from the TIDEWORK_PASSWORD env var
        /// (preferred — keeps it out of shell history).
        #[arg(long)]
        password: Option<String>,
    },
    /// Show the currently logged-in user, or report that none is.
    Whoami,
    /// Log out: forget the saved session and delete the local crypto store.
    Logout,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .with_writer(std::io::stderr)
        .init();

    if let Err(err) = run().await {
        eprintln!("error: {err:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Login {
            homeserver,
            user,
            password,
        } => login(homeserver, user, password).await,
        Command::Whoami => whoami().await,
        Command::Logout => logout(),
    }
}

async fn login(homeserver: String, user: String, password: Option<String>) -> Result<()> {
    let password = password
        .or_else(|| std::env::var("TIDEWORK_PASSWORD").ok())
        .filter(|p| !p.is_empty())
        .ok_or_else(|| {
            anyhow!("no password: pass --password or set the TIDEWORK_PASSWORD env var")
        })?;

    let paths = session::Paths::resolve()?;
    paths.ensure_dirs()?;

    let client = MatrixClient::with_sqlite_store(&homeserver, &paths.store_dir)
        .await
        .context("building client")?;
    client
        .login(&user, &password)
        .await
        .context("login failed")?;

    let blob = client
        .session_json()
        .ok_or_else(|| anyhow!("login succeeded but no session was produced"))?;
    paths.save_session(&homeserver, &blob)?;

    let who = client.user_id().unwrap_or_else(|| user.clone());
    println!("Logged in as {who}");
    println!("Session saved to {}", paths.config_dir.display());
    Ok(())
}

async fn whoami() -> Result<()> {
    let paths = session::Paths::resolve()?;
    let Some(saved) = paths.load_session()? else {
        println!("Not logged in. Run `tidework login --homeserver <url> --user <name>`.");
        return Ok(());
    };

    // Restore against the persistent store to prove the session is still valid
    // and the crypto state is intact, then report the live identity.
    let client =
        MatrixClient::restore_with_store(&saved.homeserver, &paths.store_dir, &saved.session)
            .await
            .context("restoring session")?;
    let who = client
        .user_id()
        .or_else(|| saved.user_id())
        .unwrap_or_else(|| "<unknown>".to_string());
    println!("Logged in as {who}");
    println!("Homeserver:   {}", saved.homeserver);
    Ok(())
}

fn logout() -> Result<()> {
    let paths = session::Paths::resolve()?;
    let had_session = paths.session_file.exists();
    paths.clear()?;
    if had_session {
        println!("Logged out. Local session and crypto store cleared.");
    } else {
        println!("No active session.");
    }
    Ok(())
}

/// Re-exported for the `session` module's path helpers.
pub(crate) fn home_dir() -> Result<PathBuf> {
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return Ok(PathBuf::from(home));
        }
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        if !profile.is_empty() {
            return Ok(PathBuf::from(profile));
        }
    }
    Err(anyhow!(
        "could not determine home directory (HOME/USERPROFILE)"
    ))
}
