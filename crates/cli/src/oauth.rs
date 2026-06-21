//! Loopback OAuth 2.0 / MAS login for the CLI (RFC 8252 native-app flow).
//!
//! In a single process we: start the OAuth login (which holds the PKCE verifier
//! inside the client), bind a `127.0.0.1` listener for the redirect, send the
//! user to the authorization URL in their browser, catch the one redirect that
//! carries the authorization code, and finish the login on the same client.
//! Because it's all one process, the client (and its PKCE state) stays alive
//! across start → finish.

use anyhow::{anyhow, Context, Result};
use tables_over_matrix::MatrixClient;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

/// Drive the full loopback OAuth flow against an already-built `client`.
pub async fn loopback_login(client: &MatrixClient) -> Result<()> {
    // Ephemeral loopback port for the redirect; we register exactly this URI.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .context("binding loopback redirect listener")?;
    let port = listener
        .local_addr()
        .context("reading loopback port")?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let auth_url = client
        .oauth_start(&redirect_uri)
        .await
        .context("starting OAuth login")?;

    println!("\nOpen this URL in your browser to sign in:\n");
    println!("    {auth_url}\n");
    try_open_browser(&auth_url);
    println!("Waiting for the browser to redirect back…");

    let redirected = accept_redirect(&listener, port)
        .await
        .context("awaiting OAuth redirect")?;
    client
        .oauth_finish(&redirected)
        .await
        .context("completing OAuth login")?;
    Ok(())
}

/// Accept one HTTP connection from the browser redirect, reconstruct the full
/// redirected URL (with the `?code=…&state=…` query), and reply with a small
/// success page.
async fn accept_redirect(listener: &TcpListener, port: u16) -> Result<String> {
    let (stream, _) = listener.accept().await?;
    let mut reader = BufReader::new(stream);

    // First request line: "GET /callback?code=...&state=... HTTP/1.1"
    let mut request_line = String::new();
    reader.read_line(&mut request_line).await?;
    let path = request_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| anyhow!("malformed HTTP request from browser: {request_line:?}"))?;
    let full_url = format!("http://127.0.0.1:{port}{path}");

    // Friendly response so the browser tab shows success, then close.
    let body = "<!doctype html><html><head><meta charset=\"utf-8\">\
                <title>TideWork CLI</title></head>\
                <body style=\"font-family:sans-serif;max-width:32rem;margin:4rem auto\">\
                <h2>TideWork CLI</h2>\
                <p>Login complete — you can close this tab and return to the terminal.</p>\
                </body></html>";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let mut stream = reader.into_inner();
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await?;
    Ok(full_url)
}

/// Best-effort: try to open the user's browser. The URL is always printed too,
/// so failure here is harmless (common in headless/WSL shells). Covers Linux
/// desktops, WSL (`wslview` reaches the Windows browser), and macOS.
fn try_open_browser(url: &str) {
    for cmd in ["xdg-open", "wslview", "open"] {
        let opened = std::process::Command::new(cmd)
            .arg(url)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .is_ok();
        if opened {
            return;
        }
    }
}
