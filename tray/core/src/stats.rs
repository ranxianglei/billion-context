use crate::net;
use crate::{BiliStats, BiliStatus, SessionStats, TrayState};
use serde_json::Value;
use std::time::Duration;

fn num(v: Option<&Value>) -> u64 {
    v.and_then(Value::as_f64)
        .map(|f| f.max(0.0) as u64)
        .unwrap_or(0)
}

pub fn parse_status(v: &Value) -> Result<BiliStatus, String> {
    let o = v.as_object().ok_or("status: not an object")?;
    let version = o
        .get("version")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("status: missing version")?
        .to_string();
    Ok(BiliStatus {
        version,
        disk_version: o
            .get("diskVersion")
            .and_then(Value::as_str)
            .map(str::to_string),
        stale: o.get("stale").and_then(Value::as_bool).unwrap_or(false),
        advisory_reason: o
            .get("advisory")
            .and_then(|a| a.get("reason"))
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn parse_session(v: &Value) -> Option<SessionStats> {
    Some(SessionStats {
        id: v.get("id")?.as_str()?.to_string(),
        label: v.get("label").and_then(Value::as_str).map(str::to_string),
        title: v
            .get("title")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        context_tokens: num(v.get("contextTokens")),
        context_window: v
            .get("contextWindow")
            .and_then(Value::as_f64)
            .filter(|f| *f > 0.0)
            .map(|f| f as u64),
        input_tokens: num(v.get("inputTokens")),
        cached_tokens: num(v.get("cachedTokens")),
        cache_samples: num(v.get("cacheSamples")),
    })
}

/// Best-effort: anything malformed yields an empty session list rather than
/// an error — the status endpoint is the gate, stats is display data.
pub fn parse_stats(v: &Value) -> BiliStats {
    let sessions = v
        .get("sessions")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(parse_session).collect())
        .unwrap_or_default();
    BiliStats { sessions }
}

/// One polling round against the local proxy. `status` must answer with a
/// recognizable shape or the state is Offline (guards against a foreign
/// service squatting on the port); `stats` failures degrade to zero sessions.
pub fn poll_once(cfg: &crate::config::Config) -> TrayState {
    let base = format!("http://127.0.0.1:{}", cfg.port);
    let timeout = Duration::from_millis(cfg.timeout_ms);

    let body = match net::get(&base, "/__bili/status", timeout) {
        Ok(b) => b,
        Err(e) => return TrayState::Offline { detail: e.detail() },
    };
    let value: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return TrayState::Offline {
                detail: "bad json".into(),
            }
        }
    };
    let status = match parse_status(&value) {
        Ok(s) => s,
        Err(detail) => return TrayState::Offline { detail },
    };

    let stats = match net::get(&base, "/__bili/stats", timeout) {
        Ok(b) => serde_json::from_slice::<Value>(&b)
            .map(|v| parse_stats(&v))
            .unwrap_or_default(),
        Err(_) => BiliStats::default(),
    };

    TrayState::Online { status, stats }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_status_happy_path() {
        let v: Value = serde_json::from_str(
            r#"{"version":"0.1.197","diskVersion":"0.1.198","stale":true,"advisory":{"reason":"broken fold","targetFailed":false}}"#,
        )
        .unwrap();
        assert_eq!(
            parse_status(&v).unwrap(),
            BiliStatus {
                version: "0.1.197".into(),
                disk_version: Some("0.1.198".into()),
                stale: true,
                advisory_reason: Some("broken fold".into()),
            }
        );
    }

    #[test]
    fn parse_status_minimal_and_rejects_garbage() {
        let v: Value = serde_json::from_str(r#"{"version":"0.1.1"}"#).unwrap();
        let s = parse_status(&v).unwrap();
        assert!(!s.stale);
        assert_eq!(s.disk_version, None);
        assert!(parse_status(&Value::String("hi".into())).is_err());
        assert!(parse_status(&Value::Object(Default::default())).is_err());
    }

    #[test]
    fn parse_stats_skips_malformed_sessions() {
        let v: Value = serde_json::from_str(
            r#"{"sessions":[{"id":"a","contextTokens":1500,"contextWindow":2000,"inputTokens":100,"cachedTokens":99,"cacheSamples":3},{"id":"b"},{"nope":true},"c"]}"#,
        )
        .unwrap();
        let s = parse_stats(&v);
        assert_eq!(s.sessions.len(), 2);
        assert_eq!(s.sessions[0].id, "a");
        assert_eq!(s.sessions[0].context_tokens, 1500);
        assert_eq!(s.sessions[0].context_window, Some(2000));
        assert_eq!(s.sessions[1].id, "b");
        assert_eq!(s.sessions[1].context_tokens, 0);
    }

    #[test]
    fn parse_stats_empty_shapes() {
        assert!(parse_stats(&Value::Null).sessions.is_empty());
        assert!(parse_stats(&serde_json::json!({"sessions":"nope"}))
            .sessions
            .is_empty());
    }
}
