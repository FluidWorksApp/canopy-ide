//! Opt-in crash reporting. Two crash sources funnel into one payload: the
//! renderer (a React error boundary catching a JS throw) and native (a Rust
//! panic). A renderer crash POSTs immediately when the user chooses to report
//! it; a native panic can't be trusted to do network I/O mid-unwind, so it's
//! written to `~/.canopy/pending-crash.json` and offered on the next launch.
//!
//! There are two destinations, and they make opposite privacy trades:
//!
//!   * **A GitHub issue** (preferred) — filed through the user's own `gh` login
//!     against Canopy's public tracker. It needs no server of ours, and the
//!     reporter gets a URL they can watch. It is also public and permanently
//!     attributed to their account, so this path is never automatic: the
//!     frontend shows the exact body first and the user edits or cancels it.
//!   * **The email collector** — anonymous, but depends on our infrastructure.
//!     Gated on the `crashReporting` opt-in (default off), which is what the
//!     Settings toggle governs.
//!
//! Either way the payload is deliberately minimal: message + stack, app
//! version, OS/arch and a timestamp. No file contents, repo names or account
//! data — and anything bound for a public issue has the user's home directory
//! scrubbed out of it first.

use serde::{Deserialize, Serialize};

/// Collector URL the app ships with — baked in at build time. Reports POST here
/// (see the canopyide.dev `POST /api/crash` route, which emails them internally
/// via Resend). Empty would make reporting a no-op; to change where reports go,
/// edit this and rebuild.
pub const CRASH_ENDPOINT: &str = "https://canopyide.dev/api/crash";

/// The minimal crash payload. Built entirely in the backend so the version,
/// OS and arch are the ones that actually shipped, not whatever the webview
/// believes.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CrashReport {
    /// "renderer" (React error boundary) or "native" (Rust panic).
    pub source: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    pub app_version: String,
    pub os: String,
    pub arch: String,
    /// Unix epoch milliseconds — when the report was assembled.
    pub timestamp_ms: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn build_report(source: &str, message: String, stack: Option<String>) -> CrashReport {
    CrashReport {
        source: source.to_string(),
        message,
        stack,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        timestamp_ms: now_ms(),
    }
}

async fn post_report(report: &CrashReport) -> Result<(), String> {
    let url = CRASH_ENDPOINT.trim();
    if url.is_empty() {
        return Err("No crash-report endpoint is configured in this build.".to_string());
    }
    let body = serde_json::to_string(report).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "collector returned HTTP {}",
            resp.status().as_u16()
        ))
    }
}

/// `~/.canopy/pending-crash.json` — where a native panic parks its report so
/// the next launch can offer to send it. Shares the `~/.canopy` dir the rest
/// of the backend already writes to.
fn pending_path() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    let dir = std::path::PathBuf::from(home).join(".canopy");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("pending-crash.json"))
}

/// Catch native panics and persist them for next-launch reporting, keeping the
/// process's prior behaviour (default hook: message to stderr / the dev log)
/// intact. Persisting is all we do here — a panicking thread is the wrong place
/// to open a socket.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // `info`'s type differs across Rust versions (PanicInfo vs
        // PanicHookInfo); leaving it inferred keeps this compiling on our MSRV.
        let payload = info.payload();
        let message = if let Some(s) = payload.downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "panic with a non-string payload".to_string()
        };
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        let stack = match info.location() {
            Some(l) => format!("at {}:{}:{}\n{backtrace}", l.file(), l.line(), l.column()),
            None => backtrace,
        };
        let report = build_report("native", message, Some(stack));
        if let (Some(path), Ok(json)) = (pending_path(), serde_json::to_string(&report)) {
            let _ = std::fs::write(&path, json);
        }
        previous(info);
    }));
}

/// Report a renderer (React) crash. The frontend passes the raw error; the
/// collector is the one baked into this build (CRASH_ENDPOINT).
#[tauri::command]
pub async fn report_crash(
    source: String,
    message: String,
    stack: Option<String>,
) -> Result<(), String> {
    let report = build_report(&source, message, stack);
    post_report(&report).await
}

/// POST a report that's already assembled — used to flush the pending native
/// crash the frontend picked up via `take_pending_crash`.
#[tauri::command]
pub async fn send_crash(report: CrashReport) -> Result<(), String> {
    post_report(&report).await
}

/// Read and clear the parked native-crash report, if any. Clearing on read is
/// deliberate: a report is offered exactly once, so a crash loop can't nag on
/// every launch.
#[tauri::command]
pub async fn take_pending_crash() -> Option<CrashReport> {
    let path = pending_path()?;
    let data = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    serde_json::from_str(&data).ok()
}

// ---------- GitHub issue path ----------

/// Where crash issues are filed. Hardcoded on purpose: a Canopy crash belongs
/// in Canopy's tracker, never in whatever repo the user happens to have open —
/// that one is very likely private, and very likely someone else's.
pub const CRASH_ISSUE_REPO: &str = "FluidWorksApp/canopy-ide";

/// Longest stack we paste into an issue. Well under any argv limit, and past
/// this point a backtrace stops being the useful part of a bug report.
const MAX_ISSUE_STACK: usize = 12_000;

/// Everything needed to show the user exactly what would be published, before
/// anything is. The frontend renders this for review and sends `body` back
/// (possibly edited) to `file_crash_issue`.
#[derive(Serialize, Clone, Debug)]
pub struct CrashIssueDraft {
    pub repo: String,
    pub title: String,
    pub body: String,
    /// Dedup token, already embedded in `body`. Round-tripped so an edited body
    /// still searches for the right existing issue.
    pub fingerprint: String,
}

/// What happened when we filed. `existing: true` means we found a matching
/// report and commented on it instead of opening a duplicate.
#[derive(Serialize, Clone, Debug)]
pub struct CrashIssueOutcome {
    pub url: String,
    pub existing: bool,
}

/// Replace `home` with `~` throughout. A GitHub issue is public and effectively
/// permanent, and a native backtrace embeds absolute paths without asking —
/// which leaks the account name and whatever the project is called.
///
/// Takes the home directory rather than reading the environment so it stays a
/// pure function: tests that pointed `$HOME` somewhere fake would race the
/// suites that legitimately scan the real one (see `instructions.rs`).
fn scrub(s: &str, home: &str) -> String {
    let home = home.trim_end_matches(['/', '\\']);
    if home.is_empty() {
        return s.to_string();
    }
    s.replace(home, "~")
}

fn home_dir() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default()
}

/// Stable id for "this is the same crash". Deliberately excludes the app
/// version: the same bug reported from three releases should land on one issue
/// (each new report adds a comment naming its version) rather than three.
///
/// Alphanumeric on purpose — GitHub's search tokenizes on punctuation, so a
/// hyphenated marker would not survive an `in:body` query.
fn fingerprint(source: &str, message: &str) -> String {
    let first = message.lines().next().unwrap_or("").trim();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in format!("{source}|{first}").as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("canopycrashsig{h:016x}")
}

/// `YYYY-MM-DD HH:MM:SS UTC` from epoch millis. Hand-rolled (Hinnant's
/// civil-from-days) because the backend carries no date dependency and one
/// timestamp in a crash report doesn't justify adding one.
fn utc_stamp(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let (days, tod) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    let (h, min, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    format!("{y:04}-{m:02}-{d:02} {h:02}:{min:02}:{s:02} UTC")
}

fn draft_from(report: &CrashReport, home: &str) -> CrashIssueDraft {
    let fp = fingerprint(&report.source, &report.message);
    let message = scrub(&report.message, home);
    let first = message.lines().next().unwrap_or("").trim();
    let title = format!(
        "[crash] {}",
        if first.is_empty() {
            "(no message)"
        } else {
            first
        }
    );

    let stack = report
        .stack
        .as_deref()
        .map(|s| scrub(s, home))
        .unwrap_or_default();
    let stack_block = if stack.is_empty() {
        "_(none captured)_".to_string()
    } else {
        let clipped = stack.len() > MAX_ISSUE_STACK;
        let body = if clipped {
            format!("{}\n… truncated …", &stack[..MAX_ISSUE_STACK])
        } else {
            stack
        };
        format!("<details>\n<summary>Stack</summary>\n\n```\n{body}\n```\n\n</details>")
    };

    let body = format!(
        "### What I was doing\n\
         \n\
         <!-- Anything you remember from just before the crash helps a lot. \
         Delete this line if you'd rather not say. -->\n\
         \n\
         ### Crash\n\
         \n\
         | | |\n\
         |---|---|\n\
         | source | `{source}` |\n\
         | app version | `{version}` |\n\
         | os / arch | `{os}` / `{arch}` |\n\
         | when | {when} |\n\
         \n\
         ```\n{message}\n```\n\
         \n\
         {stack_block}\n\
         \n\
         <sub>Filed from Canopy's crash reporter. Home paths are replaced with `~`.</sub>\n\
         \n\
         <!-- fingerprint: {fp} -->\n",
        source = report.source,
        version = report.app_version,
        os = report.os,
        arch = report.arch,
        when = utc_stamp(report.timestamp_ms),
    );

    CrashIssueDraft {
        repo: CRASH_ISSUE_REPO.to_string(),
        title,
        body,
        fingerprint: fp,
    }
}

/// Build the issue we *would* file, so the user can read it before deciding.
/// Nothing leaves the machine here.
#[tauri::command]
pub async fn crash_issue_draft(
    source: String,
    message: String,
    stack: Option<String>,
) -> CrashIssueDraft {
    draft_from(&build_report(&source, message, stack), &home_dir())
}

/// File the issue through the user's own `gh` login — or, when an issue with
/// this fingerprint already exists, comment on it. Returns the URL either way
/// so the reporter has somewhere to follow along.
#[tauri::command]
pub async fn file_crash_issue(
    title: String,
    body: String,
    fingerprint: String,
) -> Result<CrashIssueOutcome, String> {
    // `--state all`: a fingerprint match on a closed issue is a regression
    // worth reopening the conversation on, not grounds for a fresh report.
    let mut find = crate::git::gh_anywhere();
    find.args([
        "issue",
        "list",
        "--repo",
        CRASH_ISSUE_REPO,
        "--state",
        "all",
        "--limit",
        "1",
        "--search",
        &format!("{fingerprint} in:body"),
        "--json",
        "number,url",
    ]);
    // A search failure is not fatal — worst case we open a duplicate, which is
    // a far better outcome than losing the report.
    let existing = crate::git::run_net(&mut find)
        .ok()
        .and_then(|out| serde_json::from_str::<serde_json::Value>(&out).ok())
        .and_then(|v| v.as_array().and_then(|a| a.first()).cloned());

    if let Some(hit) = existing {
        let number = hit["number"].as_i64().unwrap_or(0);
        let url = hit["url"].as_str().unwrap_or_default().to_string();
        if number > 0 && !url.is_empty() {
            let mut c = crate::git::gh_anywhere();
            c.args([
                "issue",
                "comment",
                &number.to_string(),
                "--repo",
                CRASH_ISSUE_REPO,
                "--body",
                &body,
            ]);
            crate::git::run_net(&mut c)?;
            return Ok(CrashIssueOutcome {
                url,
                existing: true,
            });
        }
    }

    let mut create = crate::git::gh_anywhere();
    create.args([
        "issue",
        "create",
        "--repo",
        CRASH_ISSUE_REPO,
        "--title",
        &title,
        "--body",
        &body,
    ]);
    let out = crate::git::run_net(&mut create)?;
    // gh prints the new issue's URL; it's the last URL-ish line either way.
    let url = out
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with("https://"))
        .map(|l| l.trim().to_string())
        .ok_or_else(|| format!("gh created the issue but printed no URL: {out}"))?;
    Ok(CrashIssueOutcome {
        url,
        existing: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(source: &str, message: &str, stack: Option<&str>) -> CrashReport {
        CrashReport {
            source: source.into(),
            message: message.into(),
            stack: stack.map(Into::into),
            app_version: "1.2.3".into(),
            os: "macos".into(),
            arch: "aarch64".into(),
            timestamp_ms: 1_700_000_000_000,
        }
    }

    #[test]
    fn the_fingerprint_ignores_everything_after_the_first_line() {
        let a = fingerprint("renderer", "Can't find variable: agentMenu\nat Foo");
        let b = fingerprint("renderer", "Can't find variable: agentMenu\nat Bar");
        assert_eq!(a, b);
    }

    #[test]
    fn a_different_crash_gets_a_different_fingerprint() {
        assert_ne!(
            fingerprint("renderer", "Can't find variable: agentMenu"),
            fingerprint("renderer", "Can't find variable: taskMenu")
        );
        // Source is part of the identity: the same text from a Rust panic is a
        // different bug from the same text in the webview.
        assert_ne!(
            fingerprint("renderer", "boom"),
            fingerprint("native", "boom")
        );
    }

    #[test]
    fn the_fingerprint_survives_github_search_tokenizing() {
        let fp = fingerprint("renderer", "boom");
        assert!(fp.chars().all(|c| c.is_ascii_alphanumeric()), "{fp}");
    }

    const HOME: &str = "/Users/testuser";

    #[test]
    fn scrub_replaces_the_home_directory() {
        let out = scrub(
            "thread panicked at /Users/testuser/code/secret-client/src/a.rs:9",
            HOME,
        );
        assert_eq!(out, "thread panicked at ~/code/secret-client/src/a.rs:9");
        assert!(!out.contains("testuser"));
    }

    #[test]
    fn scrub_tolerates_a_trailing_separator_and_an_unknown_home() {
        assert_eq!(scrub("/Users/testuser/x", "/Users/testuser/"), "~/x");
        // No home to find: pass the text through rather than mangling it.
        assert_eq!(scrub("/Users/testuser/x", ""), "/Users/testuser/x");
    }

    #[test]
    fn the_draft_scrubs_both_message_and_stack() {
        let d = draft_from(
            &report(
                "native",
                "failed to open /Users/testuser/notes.md",
                Some("at /Users/testuser/canopy/src/git.rs:1"),
            ),
            HOME,
        );
        assert!(!d.body.contains("testuser"), "{}", d.body);
        assert!(!d.title.contains("testuser"), "{}", d.title);
        assert!(d.body.contains("~/notes.md"));
        assert!(d.body.contains("~/canopy/src/git.rs"));
    }

    #[test]
    fn the_draft_embeds_the_fingerprint_it_reports() {
        let d = draft_from(&report("renderer", "boom", None), HOME);
        assert!(d.body.contains(&d.fingerprint));
        assert_eq!(d.repo, CRASH_ISSUE_REPO);
    }

    #[test]
    fn the_title_is_the_first_line_only() {
        let d = draft_from(&report("renderer", "boom\nsecond line", None), HOME);
        assert_eq!(d.title, "[crash] boom");
    }

    #[test]
    fn an_empty_message_still_makes_a_usable_title() {
        assert_eq!(
            draft_from(&report("native", "", None), HOME).title,
            "[crash] (no message)"
        );
    }

    #[test]
    fn an_oversized_stack_is_truncated() {
        let huge = "x".repeat(MAX_ISSUE_STACK * 2);
        let d = draft_from(&report("renderer", "boom", Some(&huge)), HOME);
        assert!(d.body.contains("… truncated …"));
        assert!(d.body.len() < MAX_ISSUE_STACK + 2_000);
    }

    #[test]
    fn a_missing_stack_says_so_instead_of_rendering_an_empty_block() {
        let d = draft_from(&report("renderer", "boom", None), HOME);
        assert!(d.body.contains("_(none captured)_"));
    }

    #[test]
    fn utc_stamp_formats_a_known_instant() {
        assert_eq!(utc_stamp(1_700_000_000_000), "2023-11-14 22:13:20 UTC");
        assert_eq!(utc_stamp(0), "1970-01-01 00:00:00 UTC");
        // A leap day, since the civil-from-days maths is where this would break.
        assert_eq!(utc_stamp(1_709_164_800_000), "2024-02-29 00:00:00 UTC");
    }
}
