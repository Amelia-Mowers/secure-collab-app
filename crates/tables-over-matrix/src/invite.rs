//! Workspace invite links: the token, and the room state that validates one.
//!
//! # Why this exists
//!
//! Sharing a workspace used to require the colleague's full Matrix ID, which
//! means they had to already have an account — the invite flow demanded
//! protocol literacy from the one person who has not yet agreed to try the
//! product.
//!
//! A link cannot be an ordinary Matrix invite, because an invite names a user
//! and a link-holder has no user id until they sign up. So the link carries a
//! secret; the invitee signs in or signs up, then **knocks** on the room
//! presenting it; an admin's client verifies the secret and admits them. This
//! module is the secret and the verification — no Matrix, no I/O, so the rules
//! below are tested natively rather than through a homeserver.
//!
//! # What the server can see
//!
//! Room state is **not** encrypted: the homeserver reads every state event.
//! So the state event stores a SHA-256 of the token and never the token
//! itself, and the token is 32 bytes of CSPRNG output — enough that a server
//! holding the hash cannot search for the preimage.
//!
//! The token does travel in the knock's `reason`, which the server also sees.
//! That is not the weakness it looks like: the homeserver already controls
//! room membership outright, so a hostile server never needed the token to add
//! a member. What the hash protects is the *link* — a leaked state event must
//! not let anyone mint a working link, and it does not.
//!
//! Membership is not access to content. A new member reads history only
//! because the admitting client shares keys on invite; the server holds
//! ciphertext throughout.

use serde::{Deserialize, Serialize};

/// State event type carrying one invite link's validity. The state key is the
/// token's public id, so a room holds several live links independently.
pub const INVITE_STATE_TYPE: &str = "io.tidework.invite";

/// Bytes of randomness in a token. 32 bytes is well past the point where
/// guessing beats attacking anything else in the system.
const TOKEN_BYTES: usize = 32;

/// How a token fails to admit its holder. Distinguished so the UI can say
/// which — "expired" and "not a link for this workspace" send someone to very
/// different next steps.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InviteError {
    #[error("this invite link is not valid for this workspace")]
    NotFound,
    #[error("this invite link has expired")]
    Expired,
    #[error("this invite link has already been used the maximum number of times")]
    Exhausted,
    #[error("this invite link has been revoked")]
    Revoked,
    #[error("this invite link is not valid")]
    BadToken,
}

/// One invite link, as stored in room state.
///
/// Deliberately holds no secret. Everything here is readable by the
/// homeserver and by every room member, and none of it is enough to use the
/// link.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InviteContent {
    /// Lowercase hex SHA-256 of the token.
    pub token_hash: String,
    /// Who minted it, for the audit trail a workspace admin will want.
    pub created_by: String,
    /// Unix milliseconds.
    pub created_ts: u64,
    /// Unix milliseconds, or `None` for a link that does not expire.
    pub expires_ts: Option<u64>,
    /// How many people may join with it, or `None` for unlimited.
    pub uses_allowed: Option<u32>,
    /// How many already have.
    #[serde(default)]
    pub uses: u32,
    /// Revoked links are kept rather than deleted: the state event is the
    /// record that the link existed, and removing it would leave an admin
    /// unable to tell a revoked link from one that never was.
    #[serde(default)]
    pub revoked: bool,
}

/// A freshly minted link: the secret to hand out, and the state to publish.
///
/// Returned together because they are only ever produced together, and the
/// secret exists exactly once — it is not recoverable from the state event,
/// by us or by anyone else.
#[derive(Debug, Clone)]
pub struct NewInvite {
    /// The secret. Goes in the link, and is never stored.
    pub token: String,
    /// The state key to publish `content` under.
    pub token_id: String,
    pub content: InviteContent,
}

/// Lowercase hex SHA-256 of a token.
pub fn token_hash(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(token.as_bytes());
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        // Infallible into a String; the `let _` keeps clippy quiet without
        // pretending an error is possible.
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// The link's public identifier: the first 16 hex characters of the hash.
///
/// Used as the state key so a client can look up exactly one event instead of
/// scanning every invite in the room. It is derived from the hash rather than
/// generated separately, so an event and its token cannot disagree about which
/// link they belong to.
pub fn token_id(token: &str) -> String {
    token_hash(token)[..16].to_string()
}

/// URL-safe base64 without padding — a token goes in a link, so `+`, `/` and
/// `=` would all need escaping and would survive a copy-paste badly.
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        let idx = [n >> 18 & 63, n >> 12 & 63, n >> 6 & 63, n & 63];
        // One output character per 6 input bits actually present.
        for i in 0..(chunk.len() * 8).div_ceil(6) {
            out.push(ALPHABET[idx[i] as usize] as char);
        }
    }
    out
}

/// Mint a link.
///
/// `now_ms` and the lifetime are passed in rather than read from a clock here:
/// this crate compiles to wasm, where there is no `SystemTime`, and a rule
/// that takes its own time is a rule that cannot be tested at a chosen one.
pub fn mint(
    created_by: impl Into<String>,
    now_ms: u64,
    valid_for_ms: Option<u64>,
    uses_allowed: Option<u32>,
) -> Result<NewInvite, getrandom::Error> {
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::getrandom(&mut bytes)?;
    let token = base64url(&bytes);
    Ok(NewInvite {
        token_id: token_id(&token),
        content: InviteContent {
            token_hash: token_hash(&token),
            created_by: created_by.into(),
            created_ts: now_ms,
            expires_ts: valid_for_ms.map(|d| now_ms.saturating_add(d)),
            uses_allowed,
            uses: 0,
            revoked: false,
        },
        token,
    })
}

/// Would this token admit its holder right now?
///
/// Constant-time comparison is deliberately NOT used: the value compared is a
/// hash of the secret, not the secret, and it is already public in room state.
pub fn verify(content: &InviteContent, token: &str, now_ms: u64) -> Result<(), InviteError> {
    if token.is_empty() {
        return Err(InviteError::BadToken);
    }
    if content.token_hash != token_hash(token) {
        return Err(InviteError::NotFound);
    }
    if content.revoked {
        return Err(InviteError::Revoked);
    }
    if content.expires_ts.is_some_and(|exp| now_ms >= exp) {
        return Err(InviteError::Expired);
    }
    if content
        .uses_allowed
        .is_some_and(|allowed| content.uses >= allowed)
    {
        return Err(InviteError::Exhausted);
    }
    Ok(())
}

/// The link a workspace admin copies.
///
/// The token goes in the **fragment**, which browsers never send to a server:
/// in the query string it would land in the access logs of every host the link
/// passes through, including ours.
pub fn invite_url(base: &str, room_id: &str, token: &str) -> String {
    format!(
        "{}/join#{}&{}",
        base.trim_end_matches('/'),
        urlencode(room_id),
        token
    )
}

/// Parse `#<room-id>&<token>` back out of a link's fragment.
pub fn parse_fragment(fragment: &str) -> Option<(String, String)> {
    let frag = fragment.trim_start_matches('#');
    let (room, token) = frag.split_once('&')?;
    if room.is_empty() || token.is_empty() {
        return None;
    }
    Some((urldecode(room), token.to_string()))
}

/// Percent-encode the characters a room id carries that a URL fragment must
/// not: `!room:server` needs the `!` and `:` escaped to survive intact.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => {
                use std::fmt::Write;
                let _ = write!(out, "%{b:02X}");
            }
        }
    }
    out
}

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: u64 = 3_600_000;
    const NOW: u64 = 1_700_000_000_000;

    fn invite(now: u64, valid_for: Option<u64>, uses: Option<u32>) -> NewInvite {
        mint("@alice:example.org", now, valid_for, uses).unwrap()
    }

    #[test]
    fn a_fresh_token_verifies() {
        let inv = invite(NOW, Some(HOUR), Some(5));
        assert_eq!(verify(&inv.content, &inv.token, NOW), Ok(()));
    }

    #[test]
    fn the_secret_is_not_recoverable_from_what_is_published() {
        let inv = invite(NOW, None, None);
        // Everything in the state event, concatenated, must not contain the
        // token — this is the whole security property, and it is one `serde`
        // field away from being lost.
        let published = serde_json::to_string(&inv.content).unwrap();
        assert!(
            !published.contains(&inv.token),
            "the token leaked into room state: {published}"
        );
        assert!(published.contains(&inv.content.token_hash));
    }

    #[test]
    fn tokens_are_unpredictable_and_distinct() {
        let a = invite(NOW, None, None);
        let b = invite(NOW, None, None);
        assert_ne!(a.token, b.token);
        assert_ne!(a.token_id, b.token_id);
        // 32 bytes -> 43 base64url characters, no padding.
        assert_eq!(a.token.len(), 43, "token: {}", a.token);
        assert!(
            a.token
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "token is not URL-safe: {}",
            a.token
        );
    }

    #[test]
    fn a_wrong_token_is_rejected() {
        let inv = invite(NOW, None, None);
        assert_eq!(
            verify(&inv.content, "not-the-token", NOW),
            Err(InviteError::NotFound)
        );
        assert_eq!(verify(&inv.content, "", NOW), Err(InviteError::BadToken));
    }

    #[test]
    fn expiry_is_exclusive_at_the_boundary() {
        let inv = invite(NOW, Some(HOUR), None);
        assert_eq!(verify(&inv.content, &inv.token, NOW + HOUR - 1), Ok(()));
        // At the instant it expires it is expired, not still valid — an
        // off-by-one here is a link that outlives its own stated lifetime.
        assert_eq!(
            verify(&inv.content, &inv.token, NOW + HOUR),
            Err(InviteError::Expired)
        );
    }

    #[test]
    fn a_link_with_no_expiry_never_expires() {
        let inv = invite(NOW, None, None);
        assert_eq!(verify(&inv.content, &inv.token, u64::MAX), Ok(()));
    }

    #[test]
    fn uses_are_exhausted_at_the_limit_not_past_it() {
        let mut inv = invite(NOW, None, Some(2));
        inv.content.uses = 1;
        assert_eq!(verify(&inv.content, &inv.token, NOW), Ok(()));
        inv.content.uses = 2;
        assert_eq!(
            verify(&inv.content, &inv.token, NOW),
            Err(InviteError::Exhausted)
        );
    }

    #[test]
    fn revocation_beats_a_link_that_is_otherwise_fine() {
        let mut inv = invite(NOW, None, None);
        inv.content.revoked = true;
        assert_eq!(
            verify(&inv.content, &inv.token, NOW),
            Err(InviteError::Revoked)
        );
    }

    #[test]
    fn a_wrong_token_reads_as_not_found_even_when_the_link_is_dead() {
        // Order matters: reporting "expired" for a token that was never valid
        // would confirm to a guesser that some OTHER token is the right shape.
        let mut inv = invite(NOW, Some(HOUR), None);
        inv.content.revoked = true;
        assert_eq!(
            verify(&inv.content, "wrong", NOW + HOUR * 2),
            Err(InviteError::NotFound)
        );
    }

    #[test]
    fn the_id_is_derived_from_the_token_so_they_cannot_disagree() {
        let inv = invite(NOW, None, None);
        assert_eq!(inv.token_id, token_id(&inv.token));
        assert!(inv.content.token_hash.starts_with(&inv.token_id));
        assert_eq!(inv.content.token_hash.len(), 64);
    }

    #[test]
    fn a_link_round_trips_through_its_url() {
        let inv = invite(NOW, None, None);
        let room = "!AbCdEf:example.org";
        let url = invite_url("https://app.tidework.io", room, &inv.token);

        // The token must be in the FRAGMENT, never the query — a query string
        // reaches the access log of every host on the way.
        let (before, fragment) = url.split_once('#').expect("no fragment");
        assert!(!before.contains(&inv.token), "token before the '#': {url}");
        assert!(!before.contains('?'), "token would be logged: {url}");

        let (parsed_room, parsed_token) = parse_fragment(fragment).expect("did not parse");
        assert_eq!(parsed_room, room);
        assert_eq!(parsed_token, inv.token);
        assert_eq!(verify(&inv.content, &parsed_token, NOW), Ok(()));
    }

    #[test]
    fn a_trailing_slash_on_the_base_does_not_double_up() {
        let inv = invite(NOW, None, None);
        let url = invite_url("https://app.tidework.io/", "!r:s", &inv.token);
        assert!(url.starts_with("https://app.tidework.io/join#"), "{url}");
    }

    #[test]
    fn a_malformed_fragment_is_rejected_rather_than_half_parsed() {
        assert!(parse_fragment("").is_none());
        assert!(parse_fragment("#").is_none());
        assert!(parse_fragment("#justaroom").is_none());
        assert!(parse_fragment("#&token").is_none());
        assert!(parse_fragment("#!room:server&").is_none());
    }

    #[test]
    fn base64url_matches_known_vectors() {
        // Padding-free, and the two characters that differ from standard
        // base64 are the reason this exists — get them wrong and every token
        // containing one breaks only sometimes.
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(b"foob"), "Zm9vYg");
        assert_eq!(base64url(&[0xfb, 0xff, 0xfe]), "-__-");
    }
}
