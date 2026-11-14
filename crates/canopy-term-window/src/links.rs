//! Opening OSC 8 hyperlinks on a click.
//!
//! The target is whatever the program printed, so nothing reaches the system
//! opener unless [`frame::is_safe_link`](crate::frame::is_safe_link) accepts
//! it: `http`, `https` and `mailto` only. `file:`, `javascript:`, custom
//! schemes and anything malformed are dropped, silently, because a prompt is
//! the application's decision and this window has none.
//!
//! A click follows a link only with the platform's link modifier held (Command
//! on macOS, Ctrl elsewhere, without Shift), and only when the program is not
//! taking the mouse (Shift hands it back, as for selection).

use crate::frame::is_safe_link;
use crate::shortcuts::{Mods, Platform};
use std::process::{Command, Stdio};

/// Longest target handed to the system opener, in bytes.
pub const MAX_LINK_BYTES: usize = 2048;

/// The target to open, or `None` when it must not be opened.
pub fn openable(uri: &str) -> Option<&str> {
    if uri.is_empty() || uri.len() > MAX_LINK_BYTES || uri.chars().any(char::is_control) {
        return None;
    }
    is_safe_link(uri).then_some(uri)
}

/// Whether a click with these modifiers follows the link under it.
pub fn is_link_click(mods: Mods, platform: Platform) -> bool {
    match platform {
        Platform::MacOs => mods.logo && !mods.ctrl && !mods.alt,
        Platform::Other => mods.ctrl && !mods.shift && !mods.alt && !mods.logo,
    }
}

/// The program and arguments that open `uri` on `os` (a value of
/// `std::env::consts::OS`). No shell is involved, so the target is one
/// argument whatever it contains.
pub fn opener_command(os: &str, uri: &str) -> (&'static str, Vec<String>) {
    match os {
        "macos" => ("open", vec![uri.to_string()]),
        "windows" => (
            "rundll32",
            vec!["url.dll,FileProtocolHandler".to_string(), uri.to_string()],
        ),
        _ => ("xdg-open", vec![uri.to_string()]),
    }
}

/// Starts the system opener for `uri` without waiting for it. True when it
/// started.
pub fn open(uri: &str) -> bool {
    let (program, args) = opener_command(std::env::consts::OS, uri);
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
}

/// Follows the link a click landed on: `uri` is what the screen holds under
/// the pointer, `open` starts the opener. `open` is called only for a target
/// [`openable`] accepts. True when it was called and reported success.
pub fn follow(uri: Option<String>, open: impl FnOnce(&str) -> bool) -> bool {
    match uri.as_deref().and_then(openable) {
        Some(target) => open(target),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn opened(uri: &str) -> Option<String> {
        let got = RefCell::new(None);
        follow(Some(uri.to_string()), |t| {
            *got.borrow_mut() = Some(t.to_string());
            true
        });
        got.into_inner()
    }

    #[test]
    fn only_web_and_mail_links_reach_the_opener() {
        for ok in [
            "https://example.com/a?b=c#d",
            "http://example.com",
            "HTTPS://EXAMPLE.COM",
            "mailto:someone@example.com",
        ] {
            assert_eq!(opened(ok).as_deref(), Some(ok), "{ok}");
        }
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>1</script>",
            "ssh://host",
            "vscode://open?file=x",
            "x-man-page://ls",
            "tel:+15551234",
            "https:",
            "https://",
            "mailto:",
            "example.com",
            "",
            "-n https://example.com",
            "https://example.com/\u{1b}[31m",
            "https://example.com/\n",
        ] {
            assert_eq!(opened(bad), None, "{bad:?} must not open");
        }
    }

    #[test]
    fn a_link_past_the_length_cap_does_not_open() {
        let long = format!("https://example.com/{}", "a".repeat(MAX_LINK_BYTES));
        assert_eq!(opened(&long), None);
        let fits = format!("https://example.com/{}", "a".repeat(100));
        assert!(opened(&fits).is_some());
    }

    #[test]
    fn no_link_under_the_pointer_opens_nothing() {
        let mut called = false;
        assert!(!follow(None, |_| {
            called = true;
            true
        }));
        assert!(!called);
    }

    #[test]
    fn follow_reports_whether_the_opener_started() {
        assert!(follow(Some("https://example.com".into()), |_| true));
        assert!(!follow(Some("https://example.com".into()), |_| false));
    }

    #[test]
    fn a_click_follows_a_link_only_with_the_link_modifier() {
        let none = Mods::default();
        let ctrl = Mods { ctrl: true, ..none };
        let logo = Mods { logo: true, ..none };
        assert!(!is_link_click(none, Platform::MacOs));
        assert!(!is_link_click(none, Platform::Other));
        assert!(is_link_click(logo, Platform::MacOs));
        assert!(!is_link_click(ctrl, Platform::MacOs));
        assert!(is_link_click(ctrl, Platform::Other));
        assert!(!is_link_click(logo, Platform::Other));
        let ctrl_shift = Mods {
            shift: true,
            ..ctrl
        };
        assert!(!is_link_click(ctrl_shift, Platform::Other));
    }

    #[test]
    fn the_target_is_one_argument_and_never_goes_through_a_shell() {
        let uri = "https://example.com/?a=1&b=2 && calc";
        for os in ["macos", "windows", "linux"] {
            let (_, args) = opener_command(os, uri);
            assert_eq!(args.last().map(String::as_str), Some(uri), "{os}");
        }
        assert_eq!(opener_command("macos", uri).0, "open");
        assert_eq!(opener_command("linux", uri).0, "xdg-open");
        let (program, args) = opener_command("windows", uri);
        assert_eq!(program, "rundll32");
        assert_eq!(args[0], "url.dll,FileProtocolHandler");
    }
}
