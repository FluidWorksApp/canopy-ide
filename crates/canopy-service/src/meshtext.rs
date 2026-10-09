//! What gets typed into a terminal, ported from the desktop bridge
//! (`src-tauri/src/context.rs`) so a cloud agent receives exactly what a
//! desktop agent would.

pub const MAX_MESH_TEXT: usize = 32 * 1024;
pub const MAX_MESH_ITEMS: usize = 8;
const MESH_NOTICE_CHARS: usize = 200;
const MESH_INLINE_CHARS: usize = 1_200;

/// Control characters become single spaces: a newline would submit early, and
/// ESC/^C/^D would drive the target TUI instead of landing in its composer.
pub fn sanitize_message(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_space = false;
    for ch in text.chars() {
        let keep = if ch.is_control() { ' ' } else { ch };
        if keep == ' ' {
            if !last_space && !out.is_empty() {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(keep);
            last_space = false;
        }
    }
    out.trim().to_string()
}

/// CLIs without an MCP transport cannot fetch a mesh record by id.
pub fn agent_has_mesh_reader(agent: Option<&str>) -> bool {
    !matches!(agent, Some("aider" | "omp"))
}

pub fn item_kind(path: &str) -> String {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" => "image".into(),
        _ => "file".into(),
    }
}

pub fn mesh_notice(id: &str, reply_to: Option<&str>, text: &str, items: usize) -> String {
    let flat = sanitize_message(text);
    let preview: String = flat.chars().take(MESH_NOTICE_CHARS).collect();
    let clipped = flat.chars().count() > MESH_NOTICE_CHARS || text.contains('\n');
    let reply = reply_to
        .map(|r| format!(", replying to {r}"))
        .unwrap_or_default();
    let mut notice = format!("[mesh {id}{reply}] {preview}");
    if clipped || items > 0 {
        notice.push_str(&format!(" … full message via canopy_mesh get {id}"));
        if items > 0 {
            notice.push_str(&format!(" ({items} shared item(s))"));
        }
    }
    notice
}

pub fn mesh_notice_for(message: &canopy_core::mesh::MeshMessage) -> String {
    if agent_has_mesh_reader(message.to_agent.as_deref()) {
        return mesh_notice(
            &message.id,
            message.reply_to.as_deref(),
            &message.text,
            message.items.len(),
        );
    }
    let flat = sanitize_message(&message.text);
    let preview: String = flat.chars().take(MESH_INLINE_CHARS).collect();
    let clipped = flat.chars().count() > MESH_INLINE_CHARS;
    let reply = message
        .reply_to
        .as_deref()
        .map(|id| format!(", replying to {id}"))
        .unwrap_or_default();
    let mut notice = format!("[mesh {}{}] {}", message.id, reply, preview);
    if clipped {
        notice.push_str(" … [truncated]");
    }
    if !message.items.is_empty() {
        notice.push_str(" Shared files:");
        for item in &message.items {
            notice.push(' ');
            notice.push_str(&item.path);
        }
    }
    notice
}

/// Fold `.` and `..` and resolve a relative path against the caller's
/// directory without touching the filesystem.
pub fn normalize_claim_path(raw: &str, base: Option<&str>) -> String {
    let trimmed = raw.trim();
    let joined = match (trimmed.starts_with('/'), base) {
        (false, Some(base)) if !trimmed.is_empty() => {
            format!("{}/{}", base.trim_end_matches('/'), trimmed)
        }
        _ => trimmed.to_string(),
    };
    let absolute = joined.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if matches!(out.last(), Some(&last) if last != "..") {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            p => out.push(p),
        }
    }
    let body = out.join("/");
    if absolute {
        format!("/{body}")
    } else {
        body
    }
}

pub fn path_is_within(path: &str, root: &str) -> bool {
    let path = path.trim_end_matches('/');
    let root = root.trim_end_matches('/');
    path == root || path.starts_with(&format!("{root}/"))
}

pub fn paths_overlap(a: &str, b: &str) -> bool {
    let (a, b) = (a.trim_end_matches('/'), b.trim_end_matches('/'));
    a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizing_and_paths_match_the_desktop() {
        assert_eq!(sanitize_message("a\nb\x1b[0m\x03 c"), "a b [0m c");
        assert_eq!(
            normalize_claim_path("src/../lib/a.rs", Some("/workspace")),
            "/workspace/lib/a.rs"
        );
        assert_eq!(normalize_claim_path("/../../etc", None), "/etc");
        assert!(paths_overlap("/w/src", "/w/src/a.rs"));
        assert!(!paths_overlap("/w/src", "/w/srcx"));
        assert!(mesh_notice("m1", None, "line\nline", 0).contains("canopy_mesh get m1"));
    }
}
