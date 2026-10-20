//! GUI-free core of BiliTray: polls the billion-context loopback admin API
//! (`/__bili/status`, `/__bili/stats`), parses defensively, aggregates and
//! formats what the tray icon/menu/tooltip should show.
//!
//! Deliberately no GUI dependency and no network library beyond `std::net`:
//! the whole behavior surface is unit-testable on any machine, and the
//! loopback client ignores proxy env vars by construction (127.0.0.1 must
//! never be routed through a user's HTTP proxy).

pub mod config;
pub mod format;
pub mod net;
pub mod platform;
pub mod stats;

/// Port the manual `bili start` daemon owns (the lane zone starts at 18787).
pub const DEFAULT_PORT: u16 = 8787;
pub const DEFAULT_POLL_MS: u64 = 5_000;
pub const DEFAULT_TIMEOUT_MS: u64 = 1_500;
/// Per-session lines shown in the menu before the rest collapses into one line.
pub const MAX_SESSION_LINES: usize = 8;

/// One live session as reported by `GET /__bili/stats` (defensive subset —
/// every field degrades to a neutral default when absent or mistyped).
#[derive(Debug, Clone, PartialEq)]
pub struct SessionStats {
    pub id: String,
    pub label: Option<String>,
    pub title: Option<String>,
    pub context_tokens: u64,
    pub context_window: Option<u64>,
    pub input_tokens: u64,
    pub cached_tokens: u64,
    pub cache_samples: u64,
}

/// Process-level facts from `GET /__bili/status`.
#[derive(Debug, Clone, PartialEq)]
pub struct BiliStatus {
    pub version: String,
    pub disk_version: Option<String>,
    pub stale: bool,
    pub advisory_reason: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct BiliStats {
    pub sessions: Vec<SessionStats>,
}

/// What the tray currently knows about the local proxy.
#[derive(Debug, Clone, PartialEq)]
pub enum TrayState {
    Online {
        status: BiliStatus,
        stats: BiliStats,
    },
    Offline {
        /// Short human phrase, rendered verbatim in tooltip/menu.
        detail: String,
    },
}
