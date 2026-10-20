use std::path::PathBuf;
use std::process::Command;

pub fn config_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home).join("Library/Application Support/bili-tray")
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        PathBuf::from(appdata).join("bili-tray")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = match std::env::var("XDG_CONFIG_HOME") {
            Ok(v) if std::path::Path::new(&v).is_absolute() => PathBuf::from(v),
            _ => std::env::var("HOME")
                .map(|h| PathBuf::from(h).join(".config"))
                .unwrap_or_default(),
        };
        base.join("bili-tray")
    }
}

#[cfg(target_os = "macos")]
pub fn open_in_browser(url: &str) -> std::io::Result<()> {
    Command::new("open").arg(url).spawn().map(|_| ())
}

#[cfg(target_os = "windows")]
pub fn open_in_browser(url: &str) -> std::io::Result<()> {
    // `start` takes the window title as its first argument; pass empty.
    Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn open_in_browser(url: &str) -> std::io::Result<()> {
    Command::new("xdg-open").arg(url).spawn().map(|_| ())
}

/// Where bili itself keeps state (bili.log). Mirrors the XDG layout bili
/// uses; best-effort on non-Linux platforms.
pub fn bili_state_dir() -> PathBuf {
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = match std::env::var("XDG_STATE_HOME") {
            Ok(v) if std::path::Path::new(&v).is_absolute() => PathBuf::from(v),
            _ => std::env::var("HOME")
                .map(|h| PathBuf::from(h).join(".local/state"))
                .unwrap_or_default(),
        };
        base.join("billion-context")
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home).join("Library/Application Support/billion-context")
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        PathBuf::from(appdata).join("billion-context")
    }
}

/// Open a file with the OS default handler (editor for text). Best-effort;
/// a spawn failure just leaves the menu click inert.
#[cfg(target_os = "macos")]
pub fn open_path(path: &std::path::Path) -> std::io::Result<()> {
    Command::new("open").arg(path).spawn().map(|_| ())
}

#[cfg(target_os = "windows")]
pub fn open_path(path: &std::path::Path) -> std::io::Result<()> {
    Command::new("cmd")
        .args([
            "/C",
            "start",
            "",
            path.as_os_str().to_string_lossy().as_ref(),
        ])
        .spawn()
        .map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn open_path(path: &std::path::Path) -> std::io::Result<()> {
    Command::new("xdg-open").arg(path).spawn().map(|_| ())
}
