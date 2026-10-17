use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetError {
    Unreachable(String),
    Timeout,
    Io(String),
    HttpStatus(u16),
    Malformed,
}

impl NetError {
    pub fn detail(&self) -> String {
        match self {
            NetError::Unreachable(_) => "unreachable".into(),
            NetError::Timeout => "timed out".into(),
            NetError::Io(_) => "connection error".into(),
            NetError::HttpStatus(code) => format!("http {code}"),
            NetError::Malformed => "bad response".into(),
        }
    }
}

impl std::fmt::Display for NetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.detail())
    }
}

pub fn split_base(base: &str) -> Result<(String, u16), NetError> {
    let rest = base.strip_prefix("http://").ok_or(NetError::Malformed)?;
    let rest = rest.trim_end_matches('/');
    let mut parts = rest.rsplitn(2, ':');
    let port = parts
        .next()
        .and_then(|p| p.parse::<u16>().ok())
        .filter(|p| *p >= 1)
        .ok_or(NetError::Malformed)?;
    let host = parts.next().ok_or(NetError::Malformed)?;
    if host.is_empty() {
        return Err(NetError::Malformed);
    }
    Ok((host.to_string(), port))
}

/// Minimal HTTP/1.1 GET over a direct TCP connection. No TLS, no proxy env
/// handling on purpose: the only caller is 127.0.0.1, and honoring
/// HTTP_PROXY here would break exactly the users who run proxies globally.
fn map_io(e: std::io::Error) -> NetError {
    // Deadline expiry surfaces as ErrorKind::TimedOut on some platforms
    // and as raw EAGAIN (os error 11; WSAEWOULDBLOCK 10035 on Windows) on
    // others — and the mapping has been observed to vary between runs of
    // the same binary. This crate never enables non-blocking mode itself,
    // so any EAGAIN here can only be our own read/write deadline expiring.
    if e.kind() == std::io::ErrorKind::TimedOut
        || e.kind() == std::io::ErrorKind::WouldBlock
        || matches!(e.raw_os_error(), Some(11) | Some(10035))
    {
        NetError::Timeout
    } else {
        NetError::Io(e.to_string())
    }
}

pub fn get(base: &str, path: &str, timeout: Duration) -> Result<Vec<u8>, NetError> {
    let (host, port) = split_base(base)?;
    let addr_str = format!("{host}:{port}");
    let first = addr_str
        .to_socket_addrs()
        .map_err(|e| NetError::Unreachable(e.to_string()))?
        .next()
        .ok_or_else(|| NetError::Unreachable(addr_str.clone()))?;
    let mut stream = TcpStream::connect_timeout(&first, timeout)
        .map_err(|_| NetError::Unreachable(addr_str.clone()))?;
    stream
        .set_read_timeout(Some(timeout))
        .and(stream.set_write_timeout(Some(timeout)))
        .map_err(|e| NetError::Io(e.to_string()))?;

    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {addr_str}\r\nConnection: close\r\nAccept: application/json\r\nUser-Agent: bili-tray/{}\r\n\r\n",
        env!("CARGO_PKG_VERSION")
    );
    stream.write_all(request.as_bytes()).map_err(map_io)?;

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(map_io)?;

    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n").ok_or(NetError::Malformed)?;
    let code = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or(NetError::Malformed)?;
    if code != 200 {
        return Err(NetError::HttpStatus(code));
    }
    // Node's http stack answers without Content-Length (Transfer-Encoding:
    // chunked) for these endpoints — the wire body is hex-size-framed and
    // must be decoded before JSON parsing, or every real bili reads as
    // "bad json" offline (the mock in poll_integration.rs used to send
    // Content-Length, hiding this).
    let chunked = head.lines().any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    if chunked {
        dechunk(body.as_bytes())
    } else {
        Ok(body.as_bytes().to_vec())
    }
}

/// Decode an RFC 7230 §4.1 chunked body. Trailers after the 0-size chunk
/// are ignored (read_to_end already consumed them).
fn dechunk(mut raw: &[u8]) -> Result<Vec<u8>, NetError> {
    let mut out = Vec::new();
    loop {
        let line_end = raw
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or(NetError::Malformed)?
            + 2;
        let size_line = String::from_utf8_lossy(&raw[..line_end - 2]).into_owned();
        // chunk extensions (";name=value") are not part of the size
        let size_str = size_line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_str, 16).map_err(|_| NetError::Malformed)?;
        raw = &raw[line_end..];
        if size == 0 {
            return Ok(out);
        }
        if raw.len() < size {
            return Err(NetError::Malformed);
        }
        out.extend_from_slice(&raw[..size]);
        raw = &raw[size..];
        if raw.starts_with(b"\r\n") {
            raw = &raw[2..];
        } else {
            return Err(NetError::Malformed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dechunk_decodes_multi_chunk_bodies() {
        let raw = b"4\r\nWiki\r\n5\r\npedia\r\nE\r\n in\r\n\r\nchunks.\r\n0\r\n\r\n";
        assert_eq!(
            dechunk(raw).unwrap(),
            b"Wikipedia in\r\n\r\nchunks.".to_vec()
        );
    }

    #[test]
    fn dechunk_ignores_extensions_and_uppercase_hex() {
        let raw = b"A;foo=bar\r\n0123456789\r\n0\r\n\r\n";
        assert_eq!(dechunk(raw).unwrap(), b"0123456789".to_vec());
    }

    #[test]
    fn dechunk_rejects_bad_size_lines() {
        assert!(matches!(
            dechunk(b"zz\r\nabc\r\n0\r\n\r\n"),
            Err(NetError::Malformed)
        ));
        assert!(matches!(dechunk(b"5\r\nabc"), Err(NetError::Malformed)));
    }

    #[test]
    fn split_base_parses_host_and_port() {
        assert_eq!(
            split_base("http://127.0.0.1:8787"),
            Ok(("127.0.0.1".into(), 8787))
        );
        assert_eq!(
            split_base("http://localhost:9000/"),
            Ok(("localhost".into(), 9000))
        );
        assert!(matches!(
            split_base("https://127.0.0.1:8787"),
            Err(NetError::Malformed)
        ));
        assert!(matches!(
            split_base("http://127.0.0.1:"),
            Err(NetError::Malformed)
        ));
        assert!(matches!(
            split_base("http://:8787"),
            Err(NetError::Malformed)
        ));
    }
}
