use crate::{DEFAULT_POLL_MS, DEFAULT_PORT, DEFAULT_TIMEOUT_MS};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

pub const MIN_POLL_MS: u64 = 1_000;
pub const MAX_POLL_MS: u64 = 60_000;
pub const MIN_TIMEOUT_MS: u64 = 200;
pub const MAX_TIMEOUT_MS: u64 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Config {
    pub port: u16,
    pub poll_ms: u64,
    pub timeout_ms: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            poll_ms: DEFAULT_POLL_MS,
            timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }
}

impl Config {
    pub fn clamp(mut self) -> Self {
        self.poll_ms = self.poll_ms.clamp(MIN_POLL_MS, MAX_POLL_MS);
        self.timeout_ms = self.timeout_ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
        if !(1..=65535).contains(&self.port) {
            self.port = DEFAULT_PORT;
        }
        self
    }
}

#[derive(Serialize, Deserialize)]
struct FileShape {
    port: Option<u16>,
    #[serde(rename = "pollMs")]
    poll_ms: Option<u64>,
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
}

pub fn path() -> std::path::PathBuf {
    crate::platform::config_dir().join("config.json")
}

/// Never fails: unreadable or malformed files fall back to defaults so the
/// tray always runs; unknown fields are ignored (forward compatibility).
pub fn load() -> Config {
    load_from(&path())
}

pub fn load_from(p: &Path) -> Config {
    let mut cfg = Config::default();
    let raw = match fs::read_to_string(p) {
        Ok(r) => r,
        Err(_) => return cfg,
    };
    let shape: FileShape = match serde_json::from_str(raw.trim()) {
        Ok(s) => s,
        Err(_) => return cfg,
    };
    if let Some(port) = shape.port.filter(|p| (1..=65535).contains(p)) {
        cfg.port = port;
    }
    if let Some(ms) = shape.poll_ms {
        cfg.poll_ms = ms;
    }
    if let Some(ms) = shape.timeout_ms {
        cfg.timeout_ms = ms;
    }
    cfg.clamp()
}

pub fn save(cfg: &Config) -> std::io::Result<()> {
    save_to(cfg, &path())
}

/// Atomic write (tmp + rename) so a crash mid-write cannot leave a torn file.
pub fn save_to(cfg: &Config, p: &Path) -> std::io::Result<()> {
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = p.with_extension("json.tmp");
    let shape = FileShape {
        port: Some(cfg.port),
        poll_ms: Some(cfg.poll_ms),
        timeout_ms: Some(cfg.timeout_ms),
    };
    fs::write(
        &tmp,
        serde_json::to_string_pretty(&shape).unwrap_or_default(),
    )?;
    fs::rename(&tmp, p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    // The sandbox mounts /tmp read-only, so test fixtures live next to the
    // crate (cwd during `cargo test`) with unique names per run.
    fn fixture(name: &str) -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::current_dir().unwrap().join(format!(
            "test-tmp-{}-{}-{}.json",
            std::process::id(),
            n,
            name
        ));
        let _ = fs::remove_file(&p);
        p
    }

    #[test]
    fn missing_file_gives_defaults() {
        let p = fixture("missing");
        assert_eq!(load_from(&p), Config::default());
    }

    #[test]
    fn partial_file_merges_and_clamps() {
        let p = fixture("partial");
        fs::write(&p, r#"{"port": 9000, "pollMs": 5, "timeoutMs": 999999}"#).unwrap();
        let cfg = load_from(&p);
        assert_eq!(cfg.port, 9000);
        assert_eq!(cfg.poll_ms, MIN_POLL_MS);
        assert_eq!(cfg.timeout_ms, MAX_TIMEOUT_MS);
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn save_round_trips() {
        let p = fixture("roundtrip");
        let cfg = Config {
            port: 18788,
            poll_ms: 7000,
            timeout_ms: 900,
        };
        save_to(&cfg, &p).unwrap();
        assert_eq!(load_from(&p), cfg);
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn unknown_port_falls_back() {
        let p = fixture("badport");
        fs::write(&p, r#"{"port": 0}"#).unwrap();
        assert_eq!(load_from(&p).port, DEFAULT_PORT);
        let _ = fs::remove_file(&p);
    }
}
