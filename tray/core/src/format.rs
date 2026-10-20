use crate::{SessionStats, TrayState};

pub fn fmt_tokens(n: u64) -> String {
    if n < 1_000 {
        return n.to_string();
    }
    let (mut value, mut unit) = if n < 1_000_000 {
        (n as f64 / 1_000.0, "K")
    } else {
        (n as f64 / 1_000_000.0, "M")
    };
    if value >= 999.95 {
        value /= 1_000.0;
        unit = "M";
    }
    let rounded = value.round();
    if rounded >= 100.0 || value.fract() < 0.05 {
        format!("{rounded:.0}{unit}")
    } else {
        format!("{value:.1}{unit}")
    }
}

fn pressure(s: &SessionStats) -> Option<f64> {
    s.context_window
        .filter(|w| *w > 0)
        .map(|w| s.context_tokens as f64 / w as f64)
}

/// Sessions ordered by context pressure (descending; windowless last by tokens).
pub fn sorted_sessions(stats: &[SessionStats]) -> Vec<&SessionStats> {
    let mut v: Vec<&SessionStats> = stats.iter().collect();
    v.sort_by(|a, b| {
        let pa = pressure(a);
        let pb = pressure(b);
        match (pa, pb) {
            (Some(x), Some(y)) => y.partial_cmp(&x).unwrap_or(std::cmp::Ordering::Equal),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => b.context_tokens.cmp(&a.context_tokens),
        }
    });
    v
}

#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MenuModel {
    pub header: Line,
    pub port_info: Line,
}

fn header_text(state: &TrayState) -> String {
    match state {
        TrayState::Offline { .. } => "billion-context: offline".into(),
        TrayState::Online { status, .. } => {
            let mut t = format!("billion-context v{}", status.version);
            if status.stale {
                let disk = status.disk_version.as_deref().unwrap_or("newer");
                t.push_str(&format!(" · restart pending (disk v{disk})"));
            }
            if let Some(reason) = &status.advisory_reason {
                let short: String = reason.chars().take(60).collect();
                t.push_str(&format!(" · advisory: {short}"));
            }
            t
        }
    }
}

pub fn tooltip(state: &TrayState, port: u16) -> String {
    match state {
        TrayState::Offline { detail } => {
            format!("bili offline — 127.0.0.1:{port}: {detail}")
        }
        TrayState::Online { status, stats } => {
            let mut t = format!("bili v{}", status.version);
            if stats.sessions.is_empty() {
                t.push_str(" — idle");
                return t;
            }
            let n = stats.sessions.len();
            t.push_str(&format!(" — {n} session{}", if n == 1 { "" } else { "s" }));
            let sessions = sorted_sessions(&stats.sessions);
            match sessions
                .first()
                .and_then(|s| s.context_window.filter(|w| *w > 0))
            {
                Some(w) => {
                    let top = sessions.first().expect("checked above");
                    t.push_str(&format!(
                        " · peak ctx {}/{}",
                        fmt_tokens(top.context_tokens),
                        fmt_tokens(w)
                    ));
                }
                None => {
                    let total: u64 = stats.sessions.iter().map(|s| s.context_tokens).sum();
                    t.push_str(&format!(" · Σ ctx {}", fmt_tokens(total)));
                }
            }
            let cached: u64 = stats
                .sessions
                .iter()
                .filter(|s| s.cache_samples > 0 && s.input_tokens > 0)
                .map(|s| s.cached_tokens)
                .sum();
            let input: u64 = stats
                .sessions
                .iter()
                .filter(|s| s.cache_samples > 0 && s.input_tokens > 0)
                .map(|s| s.input_tokens)
                .sum();
            let pct = cached.checked_mul(100).and_then(|c| c.checked_div(input));
            if let Some(pct) = pct {
                t.push_str(&format!(" · cache {}%", pct.min(100)));
            }
            t
        }
    }
}

pub fn menu_model(state: &TrayState, port: u16) -> MenuModel {
    let header = Line {
        id: "header".into(),
        text: header_text(state),
    };
    let port_info = match state {
        TrayState::Offline { .. } => Line {
            id: "port-info".into(),
            text: format!("port {port} — waiting for bili"),
        },
        TrayState::Online { .. } => Line {
            id: "port-info".into(),
            text: format!("port {port}"),
        },
    };
    MenuModel { header, port_info }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BiliStats, BiliStatus};

    fn sess(
        id: &str,
        ctx: u64,
        win: Option<u64>,
        input: u64,
        cached: u64,
        samples: u64,
    ) -> SessionStats {
        SessionStats {
            id: id.into(),
            label: None,
            title: None,
            context_tokens: ctx,
            context_window: win,
            input_tokens: input,
            cached_tokens: cached,
            cache_samples: samples,
        }
    }

    #[test]
    fn token_format_table() {
        assert_eq!(fmt_tokens(0), "0");
        assert_eq!(fmt_tokens(999), "999");
        assert_eq!(fmt_tokens(1_500), "1.5K");
        assert_eq!(fmt_tokens(12_345), "12.3K");
        assert_eq!(fmt_tokens(412_000), "412K");
        assert_eq!(fmt_tokens(1_200_000), "1.2M");
        assert_eq!(fmt_tokens(2_000_000), "2M");
    }

    #[test]
    fn token_format_rounds_up_at_boundary() {
        assert_eq!(fmt_tokens(99_960), "100K");
        assert_eq!(fmt_tokens(999_950_000), "1.0M");
    }

    #[test]
    fn offline_tooltip_and_menu() {
        let st = TrayState::Offline {
            detail: "unreachable".into(),
        };
        assert_eq!(
            tooltip(&st, 8787),
            "bili offline — 127.0.0.1:8787: unreachable"
        );
        let m = menu_model(&st, 8787);
        assert_eq!(m.header.text, "billion-context: offline");
        assert_eq!(m.port_info.text, "port 8787 — waiting for bili");
    }

    #[test]
    fn idle_tooltip() {
        let st = TrayState::Online {
            status: BiliStatus {
                version: "0.1.197".into(),
                disk_version: None,
                stale: false,
                advisory_reason: None,
            },
            stats: BiliStats::default(),
        };
        assert_eq!(tooltip(&st, 8787), "bili v0.1.197 — idle");
    }

    #[test]
    fn online_tooltip_peak_and_cache() {
        let st = TrayState::Online {
            status: BiliStatus {
                version: "0.1.197".into(),
                disk_version: None,
                stale: false,
                advisory_reason: None,
            },
            stats: BiliStats {
                sessions: vec![
                    sess("a", 100_000, Some(200_000), 1_000, 900, 5),
                    sess("b", 190_000, Some(200_000), 1_000, 950, 5),
                    sess("c", 50_000, None, 1_000, 990, 5),
                ],
            },
        };
        assert_eq!(
            tooltip(&st, 8787),
            "bili v0.1.197 — 3 sessions · peak ctx 190K/200K · cache 94%"
        );
    }

    #[test]
    fn stale_header_shows_disk_version() {
        let st = TrayState::Online {
            status: BiliStatus {
                version: "0.1.197".into(),
                disk_version: Some("0.1.198".into()),
                stale: true,
                advisory_reason: None,
            },
            stats: BiliStats::default(),
        };
        assert_eq!(
            header_text(&st),
            "billion-context v0.1.197 · restart pending (disk v0.1.198)"
        );
    }
}
