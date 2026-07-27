//! Wall-clock bound for a future that is allowed to hang (issue dc8bbbb8).
//!
//! ## Why this exists
//!
//! matrix-rust-sdk's WASM HTTP client **ignores its request config**:
//!
//! ```ignore
//! // matrix-sdk-0.14.0/src/http_client/wasm.rs
//! pub(super) async fn send_request<R>(
//!     &self,
//!     request: http::Request<Bytes>,
//!     _config: RequestConfig,          // <- underscore: never read
//!     _send_progress: SharedObservable<TransmissionProgress>,
//! ) -> Result<R::IncomingResponse, HttpError>
//! ```
//!
//! So `DEFAULT_REQUEST_TIMEOUT` (30 s) applies on native builds and **not in the
//! browser**, where reqwest wraps `fetch()` — which has no timeout of its own. A
//! request issued over a connection that dies without a TCP reset (sleep/resume,
//! a dropped Wi-Fi link, a NAT rebind, a captive portal) therefore never settles
//! at all.
//!
//! That is the failure the sync supervision in #174/#175 could not catch. Those
//! restart the stream when `sync_with_callback` **returns**; here it never
//! returns. `last_sync_ok_ms` freezes, so after five minutes `ConnectionStatus`
//! raises its page-blocking overlay — and, because nothing restarts, the overlay
//! stays until the user reloads. Reported 2026-07-26: "still not recovering from
//! a disconnected state without a full page reload".
//!
//! Supervising on *liveness* instead of on *return* is the fix: race the sync
//! against a timer and abandon it if the timer wins.

use std::future::Future;
use std::time::Duration;

use futures::future::{select, Either};

/// The result of running a future under a watchdog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bounded<T> {
    /// The future finished in time; here is its output.
    Completed(T),
    /// The watchdog fired first. The future has been DROPPED — see the note on
    /// [`bounded`] about why that is safe for a `/sync`.
    Stalled,
}

impl<T> Bounded<T> {
    /// The output, or `None` if the watchdog fired.
    pub fn completed(self) -> Option<T> {
        match self {
            Bounded::Completed(value) => Some(value),
            Bounded::Stalled => None,
        }
    }

    pub fn is_stalled(&self) -> bool {
        matches!(self, Bounded::Stalled)
    }
}

/// Run `future`, giving up on it after `timeout`.
///
/// On timeout the future is dropped. For a `/sync` that is safe and is what a
/// closing tab does anyway: the sync token is only persisted **after** a
/// response has been processed, so an abandoned sync means the next one re-runs
/// from the same token. Sync is idempotent by that design — the cost of
/// abandoning one is a repeated round-trip, not a gap.
///
/// `timeout` must exceed the long-poll interval, or a perfectly healthy sync
/// that simply has nothing to report gets killed every cycle.
pub async fn bounded<F>(future: F, timeout: Duration) -> Bounded<F::Output>
where
    F: Future,
{
    let future = Box::pin(future);
    let timer = Box::pin(matrix_sdk::sleep::sleep(timeout));
    match select(future, timer).await {
        Either::Left((output, _timer)) => Bounded::Completed(output),
        Either::Right(((), _abandoned)) => Bounded::Stalled,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn passes_through_a_future_that_finishes_in_time() {
        let outcome = bounded(async { 7 }, Duration::from_secs(30)).await;
        assert_eq!(outcome, Bounded::Completed(7));
        assert_eq!(outcome.completed(), Some(7));
    }

    #[tokio::test]
    async fn reports_a_stall_instead_of_waiting_forever() {
        // The browser case: a fetch over a dead-but-open connection that never
        // settles. Without this bound the caller waits for the rest of the
        // session.
        let never = std::future::pending::<()>();
        let outcome = bounded(never, Duration::from_millis(20)).await;
        assert!(outcome.is_stalled());
        assert_eq!(outcome.completed(), None);
    }

    #[tokio::test]
    async fn drops_the_stalled_future_so_it_stops_holding_resources() {
        struct NotesItsDrop(Arc<AtomicBool>);
        impl Drop for NotesItsDrop {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(AtomicBool::new(false));
        let marker = NotesItsDrop(Arc::clone(&dropped));

        let outcome = bounded(
            async move {
                let _hold = marker;
                std::future::pending::<()>().await;
            },
            Duration::from_millis(20),
        )
        .await;

        assert!(outcome.is_stalled());
        // The abandoned request must actually be released — a watchdog that left
        // the old sync pending would accumulate one per cycle.
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_slow_but_finishing_future_still_wins() {
        let outcome = bounded(
            async {
                matrix_sdk::sleep::sleep(Duration::from_millis(10)).await;
                "done"
            },
            Duration::from_millis(500),
        )
        .await;
        assert_eq!(outcome, Bounded::Completed("done"));
    }
}
