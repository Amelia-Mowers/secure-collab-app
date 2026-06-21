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

mod crud;
mod oauth;
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
    /// Log in to a homeserver and persist the session. Uses password auth by
    /// default; pass `--sso` for OAuth/MAS browser sign-in (required by the
    /// production server, which has password login disabled).
    Login {
        /// Homeserver URL, e.g. https://tidework.io
        #[arg(long)]
        homeserver: String,
        /// Sign in via OAuth 2.0 / MAS in the browser (no --user/--password).
        #[arg(long)]
        sso: bool,
        /// Username (localpart or full @user:server). Required for password auth.
        #[arg(long)]
        user: Option<String>,
        /// Password. If omitted, read from the TIDEWORK_PASSWORD env var
        /// (preferred — keeps it out of shell history). Ignored with --sso.
        #[arg(long)]
        password: Option<String>,
        /// Recovery (master) key, used to verify this device against your secure
        /// backup. If omitted, read from TIDEWORK_RECOVERY_KEY, else prompted.
        /// Required — an unverified device can't decrypt your other devices'
        /// workspaces and won't back up its own.
        #[arg(long)]
        recover_key: Option<String>,
    },
    /// Show the currently logged-in user, or report that none is.
    Whoami,
    /// Log out: forget the saved session and delete the local crypto store.
    Logout,
    /// Workspace (encrypted Matrix room) operations.
    Workspace {
        #[command(subcommand)]
        command: WorkspaceCmd,
    },
    /// Table operations within a workspace.
    Table {
        #[command(subcommand)]
        command: TableCmd,
    },
    /// Row operations within a table.
    Row {
        #[command(subcommand)]
        command: RowCmd,
    },
    /// Column operations within a table.
    Column {
        #[command(subcommand)]
        command: ColumnCmd,
    },
}

/// A workspace argument is either a room id (starts with `!`) or a workspace
/// name (resolved against your joined workspaces).
#[derive(Subcommand)]
enum WorkspaceCmd {
    /// Create a new workspace and print its room id.
    Create {
        /// Display name for the workspace.
        name: String,
    },
    /// List your workspaces.
    List,
}

#[derive(Subcommand)]
enum TableCmd {
    /// Create a table. Columns are `name:type` (type defaults to `text`; one of
    /// text|number|boolean|date|select|multiselect|document|json).
    Create {
        /// Workspace (room id or name).
        workspace: String,
        /// Display name for the table.
        name: String,
        /// Comma-separated `name:type` column specs.
        #[arg(long, value_delimiter = ',', required = true)]
        columns: Vec<String>,
    },
    /// List the tables in a workspace.
    List {
        /// Workspace (room id or name).
        workspace: String,
    },
    /// Show a table's rows, optionally filtered and sorted.
    Show {
        /// Workspace (room id or name).
        workspace: String,
        /// Table (id or name).
        table: String,
        /// Filter `col<op>value` (op: = != ~ > >= < <=); repeatable, AND-ed.
        /// e.g. --where status=open --where priority<=1
        #[arg(long = "where", allow_hyphen_values = true)]
        filter: Vec<String>,
        /// Sort by column; prefix `-` for descending. Repeatable for multi-key.
        /// e.g. --sort priority --sort -opened
        #[arg(long, allow_hyphen_values = true)]
        sort: Vec<String>,
    },
}

#[derive(Subcommand)]
enum RowCmd {
    /// Add a row. Cells are `column=value` pairs (column id or name).
    Add {
        /// Workspace (room id or name).
        workspace: String,
        /// Table (id or name).
        table: String,
        /// `column=value` assignments.
        #[arg(required = true)]
        cells: Vec<String>,
    },
}

#[derive(Subcommand)]
enum ColumnCmd {
    /// Add a column to a table. SPEC is `name:type[:opt1|opt2|...]` (the
    /// `|`-separated options apply to select/multiselect).
    Add {
        /// Workspace (room id or name).
        workspace: String,
        /// Table (id or name).
        table: String,
        /// Column spec, e.g. `status:select:open|in-progress|closed`.
        spec: String,
    },
    /// Reconfigure an existing column's allowed options / default / name.
    Set {
        /// Workspace (room id or name).
        workspace: String,
        /// Table (id or name).
        table: String,
        /// Column (id or name).
        column: String,
        /// Comma-separated allowed values (select/multiselect).
        #[arg(long)]
        options: Option<String>,
        /// Default value (must be an allowed option for select/multiselect).
        #[arg(long)]
        default: Option<String>,
        /// New display name.
        #[arg(long)]
        name: Option<String>,
    },
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            // Quiet the SDK's crypto chatter (missing-backup-key / undecryptable
            // history of *other* rooms) by default; set RUST_LOG to override.
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new(
                    "warn,matrix_sdk=error,matrix_sdk_crypto=error,matrix_sdk_base=error",
                )
            }),
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
            sso,
            user,
            password,
            recover_key,
        } => {
            if sso {
                login_sso(homeserver, recover_key).await
            } else {
                login_password(homeserver, user, password, recover_key).await
            }
        }
        Command::Whoami => whoami().await,
        Command::Logout => logout(),
        Command::Workspace { command } => match command {
            WorkspaceCmd::Create { name } => crud::workspace_create(name).await,
            WorkspaceCmd::List => crud::workspace_list().await,
        },
        Command::Table { command } => match command {
            TableCmd::Create {
                workspace,
                name,
                columns,
            } => crud::table_create(workspace, name, columns).await,
            TableCmd::List { workspace } => crud::table_list(workspace).await,
            TableCmd::Show {
                workspace,
                table,
                filter,
                sort,
            } => crud::table_show(workspace, table, filter, sort).await,
        },
        Command::Row { command } => match command {
            RowCmd::Add {
                workspace,
                table,
                cells,
            } => crud::row_add(workspace, table, cells).await,
        },
        Command::Column { command } => match command {
            ColumnCmd::Add {
                workspace,
                table,
                spec,
            } => crud::column_add(workspace, table, spec).await,
            ColumnCmd::Set {
                workspace,
                table,
                column,
                options,
                default,
                name,
            } => crud::column_set(workspace, table, column, options, default, name).await,
        },
    }
}

async fn login_password(
    homeserver: String,
    user: Option<String>,
    password: Option<String>,
    recover_key: Option<String>,
) -> Result<()> {
    let user =
        user.ok_or_else(|| anyhow!("--user is required for password login (or use --sso)"))?;
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

    finish_login(&client, &homeserver, &paths, Some(user), recover_key).await
}

async fn login_sso(homeserver: String, recover_key: Option<String>) -> Result<()> {
    let paths = session::Paths::resolve()?;
    paths.ensure_dirs()?;

    let client = MatrixClient::with_sqlite_store(&homeserver, &paths.store_dir)
        .await
        .context("building client")?;

    // Heads-up if the server doesn't actually delegate to an OAuth provider —
    // the flow would otherwise fail with a less obvious error.
    if !MatrixClient::homeserver_supports_oauth(&homeserver)
        .await
        .unwrap_or(false)
    {
        eprintln!("warning: {homeserver} does not advertise OAuth metadata; if this fails, try password login");
    }

    oauth::loopback_login(&client)
        .await
        .context("OAuth login failed")?;

    finish_login(&client, &homeserver, &paths, None, recover_key).await
}

/// Verify the freshly-authenticated device against secure backup, then persist
/// the session. Recovery is **mandatory** (matching the web app): an unverified
/// device can't decrypt workspaces created on your other devices and won't back
/// up the ones it creates, so we don't leave one usable. `fallback_user` is used
/// only if the client can't report its own id yet.
async fn finish_login(
    client: &MatrixClient,
    homeserver: &str,
    paths: &session::Paths,
    fallback_user: Option<String>,
    recover_key: Option<String>,
) -> Result<()> {
    verify_from_backup(client, recover_key).await?;

    let blob = client
        .session_json()
        .ok_or_else(|| anyhow!("login succeeded but no session was produced"))?;
    paths.save_session(homeserver, &blob)?;

    let who = client
        .user_id()
        .or(fallback_user)
        .unwrap_or_else(|| "<unknown>".to_string());
    println!("Logged in as {who}");
    println!("Device verified from secure backup — it can now decrypt your workspaces.");
    println!("Session saved to {}", paths.config_dir.display());
    Ok(())
}

/// Verify the device against secure backup, sourcing the recovery key from the
/// flag, the TIDEWORK_RECOVERY_KEY env var, or an interactive prompt (in that
/// order). On a wrong key, re-prompt when attached to a terminal (up to a few
/// tries); when non-interactive, fail immediately rather than loop on EOF.
async fn verify_from_backup(client: &MatrixClient, flag: Option<String>) -> Result<()> {
    use std::io::IsTerminal;

    // The first candidate comes from the flag/env if present; afterwards (and
    // when neither was given) we prompt.
    let mut next = flag
        .filter(|k| !k.trim().is_empty())
        .or_else(|| std::env::var("TIDEWORK_RECOVERY_KEY").ok())
        .filter(|k| !k.trim().is_empty());
    let interactive = std::io::stdin().is_terminal();

    let mut attempt = 0u32;
    loop {
        attempt += 1;
        let candidate = match next.take() {
            Some(key) => key,
            None if interactive => prompt_recovery_key()?,
            None => {
                return Err(anyhow!(
                    "no recovery key — pass --recover-key or set TIDEWORK_RECOVERY_KEY"
                ))
            }
        };

        match client.recover_with_key(&candidate).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                if !interactive || attempt >= 3 {
                    return Err(e).context(
                        "verifying this device from secure backup (check your recovery key)",
                    );
                }
                eprintln!("That recovery key didn't work. Try again.");
            }
        }
    }
}

/// Prompt for a recovery key on stderr and read one line from stdin.
fn prompt_recovery_key() -> Result<String> {
    use std::io::Write;
    eprint!("Recovery (master) key: ");
    std::io::stderr().flush().ok();
    let mut line = String::new();
    std::io::stdin()
        .read_line(&mut line)
        .context("reading recovery key")?;
    let key = line.trim().to_string();
    if key.is_empty() {
        return Err(anyhow!("a recovery key is required to verify this device"));
    }
    Ok(key)
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
