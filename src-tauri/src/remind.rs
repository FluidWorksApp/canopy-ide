//! Reminders that outlive the app.
//!
//! A note can carry a time to be brought back at (`notes::Reminder`). The
//! obvious way to honour that is a timer in the running app — and the app is
//! exactly the thing that is not running at 9am on Monday. A reminder you only
//! get while you already have Canopy open is a reminder for something you were
//! already looking at, which is not the case anyone sets one for.
//!
//! So a reminder is handed to the operating system. On macOS that is a launchd
//! agent per reminder: a plist in `~/Library/LaunchAgents` with a
//! `StartCalendarInterval` at the due minute, running `canopy-hook --remind`.
//! launchd owns the clock — it survives quitting Canopy, logging out, and a
//! reboot, and it fires on wake for a time that passed while the machine was
//! asleep. The helper posts the banner itself and, when clicked, execs the
//! Canopy binary with the note's `canopy://note?…` link, which either raises
//! the running app onto the note or launches it there (see `cli.rs`).
//!
//! Two consequences worth stating, because the rest of the feature is built on
//! them:
//!
//!   1. When the system took the reminder, the app must NOT also announce it.
//!      Both firing means two banners for one reminder. `Scheduled::System` is
//!      what the frontend reads to stay quiet; `Scheduled::InApp` is the
//!      fallback (another platform, or launchctl refused) and is the only case
//!      where the in-app tick posts to the attention channel.
//!
//!   2. The helper never writes to the note store. It runs in a process with no
//!      lock on it, possibly while the app holds one. All it does is notify and
//!      remove its own job; the app marks the reminder fired when it next looks
//!      and sees the time has passed, so an overdue note is still overdue in
//!      the panel whether or not anyone saw the banner.
//!
//! Windows and Linux get the in-app path only. `schtasks` and systemd timers
//! are both real answers and neither is written here — what stops that being a
//! silent hole is that `schedule` says which path it took, and the UI says so
//! too rather than promising a banner that will not arrive.

use std::path::{Path, PathBuf};

/// What actually holds the reminder now that it has been set.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scheduled {
    /// launchd has it. Fires with Canopy closed; the app stays quiet.
    System,
    /// Nothing outside the app has it — the in-app tick is the only alarm.
    InApp,
}

impl Scheduled {
    pub fn is_system(self) -> bool {
        matches!(self, Scheduled::System)
    }
}

pub use canopy_core::notes::ReminderJob as Job;
pub use canopy_core::when::{local_civil, Civil};

// ---- launchd --------------------------------------------------------------

/// One label per note, so re-setting a reminder replaces its job instead of
/// stacking a second one. Reverse-DNS because launchd's namespace is shared
/// with everything else the user has installed.
pub fn label(project_id: &str, note_id: &str) -> String {
    format!(
        "app.canopy.remind.{}.{}",
        sanitize(project_id),
        sanitize(note_id)
    )
}

/// Both halves are already constrained upstream (`project_dir` rejects
/// separators, `valid_id` mints ids as `nnnn-slug`), so this is the second
/// fence rather than the first — the value becomes a filename.
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect()
}

/// `CANOPY_REMIND_HOME` puts the plists somewhere harmless *and* takes
/// `launchctl` out of the picture. One switch for both because they are one
/// decision: a test run — or a dev build on the developer's own machine —
/// must not install real user agents that outlive it and start posting banners
/// from a build that no longer exists.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn sandboxed() -> Option<PathBuf> {
    std::env::var_os("CANOPY_REMIND_HOME").map(PathBuf::from)
}

#[cfg(target_os = "macos")]
fn agents_dir() -> Option<PathBuf> {
    let dir = sandboxed().or_else(|| {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/LaunchAgents"))
    })?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

pub fn plist_path(label: &str) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        Some(agents_dir()?.join(format!("{label}.plist")))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = label;
        None
    }
}

/// `<` and `&` in a note title are ordinary; in a plist they are a parse error
/// that makes the job silently never load.
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            // Control characters are not representable in XML 1.0 at all.
            c if (c as u32) < 0x20 && c != '\t' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// This build's own executable. `canopy` on PATH would be the tidier answer and
/// is not reliable: the shim in /usr/local/bin is opt-in (Settings → install
/// CLI), and a reminder must not depend on the user having asked for that.
fn app_bin() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "canopy".into())
}

/// The plist text. Pure, so the awkward parts — escaping, the calendar fields,
/// the argv the helper will be handed — are checked by tests rather than by
/// installing a job and waiting for the day.
pub fn plist(label: &str, helper: &Path, job: &Job, when: Civil) -> String {
    let args = [
        helper.to_string_lossy().into_owned(),
        "--remind".into(),
        "--label".into(),
        label.to_string(),
        "--title".into(),
        job.title.to_string(),
        "--body".into(),
        job.note.to_string(),
        "--link".into(),
        job.link.to_string(),
        // Which binary a click should open the note in. Written now, while the
        // app knows where it lives, because the helper has no way to find out
        // — it is not in the bundle, has no LaunchServices lookup, and must
        // work from a plist that may be months old.
        "--app".into(),
        app_bin(),
    ];
    let argv = args
        .iter()
        .map(|a| format!("    <string>{}</string>", xml_escape(a)))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
{argv}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Month</key><integer>{month}</integer>
    <key>Day</key><integer>{day}</integer>
    <key>Hour</key><integer>{hour}</integer>
    <key>Minute</key><integer>{minute}</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
"#,
        label = xml_escape(label),
        month = when.month,
        day = when.day,
        hour = when.hour,
        minute = when.minute,
    )
}

#[cfg(unix)]
fn gui_domain() -> String {
    format!("gui/{}", unsafe { libc::getuid() })
}

/// Hand the reminder to launchd. Returns which alarm ended up holding it.
///
/// Every failure degrades to `InApp` rather than propagating: a reminder the
/// user asked for must be *set* even if the system refused the job, and the
/// caller records which one it got so the UI can be honest about it.
pub fn schedule(job: &Job) -> Scheduled {
    #[cfg(target_os = "macos")]
    {
        let Some(helper) = helper_bin() else {
            return Scheduled::InApp;
        };
        let Some(when) = local_civil(job.at) else {
            return Scheduled::InApp;
        };
        let label = label(job.project_id, job.note_id);
        let Some(path) = plist_path(&label) else {
            return Scheduled::InApp;
        };
        if std::fs::write(&path, plist(&label, &helper, job, when)).is_err() {
            return Scheduled::InApp;
        }
        if sandboxed().is_some() {
            return Scheduled::InApp;
        }
        // Replacing an existing job: bootout first, or bootstrap reports "service
        // already loaded" and the old time stands.
        let domain = gui_domain();
        let _ = run_launchctl(&["bootout", &format!("{domain}/{label}")]);
        if run_launchctl(&["bootstrap", &domain, &path.to_string_lossy()]) {
            Scheduled::System
        } else {
            let _ = std::fs::remove_file(&path);
            Scheduled::InApp
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = job;
        Scheduled::InApp
    }
}

/// Take the job away — the reminder was cleared, moved, or its note deleted.
/// Silent about everything: there is no state where failing to remove a job the
/// user cannot see is worth an error in front of them.
pub fn unschedule(project_id: &str, note_id: &str) {
    #[cfg(target_os = "macos")]
    {
        let label = label(project_id, note_id);
        if sandboxed().is_none() {
            let _ = run_launchctl(&["bootout", &format!("{}/{}", gui_domain(), label)]);
        }
        if let Some(path) = plist_path(&label) {
            let _ = std::fs::remove_file(path);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (project_id, note_id);
    }
}

#[cfg(target_os = "macos")]
fn run_launchctl(args: &[&str]) -> bool {
    std::process::Command::new("launchctl")
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// `~/.canopy/bin/canopy-hook` — the copy `agents::install_hook_helper` keeps
/// current at startup. Deliberately not the one inside the app bundle: a
/// launchd job written today has to still resolve after Canopy is updated,
/// moved, or opened from a disk image.
#[cfg(target_os = "macos")]
fn helper_bin() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let path = PathBuf::from(home)
        .join(".canopy")
        .join("bin")
        .join("canopy-hook");
    path.exists().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_label_per_note_so_resetting_replaces_the_job() {
        assert_eq!(
            label("p1", "0007-tier-donations"),
            "app.canopy.remind.p1.0007-tier-donations"
        );
        // Second fence: whatever arrives, the label stays a filename.
        assert_eq!(label("../etc", "a/b"), "app.canopy.remind.___etc.a_b");
    }

    #[test]
    fn the_plist_survives_a_title_with_xml_in_it() {
        let job = Job {
            project_id: "p1",
            note_id: "0007-x",
            title: "Fix <Markdown> & the parser",
            note: "",
            at: 0,
            link: "canopy://note?id=p1&note=0007-x",
        };
        let out = plist(
            "app.canopy.remind.p1.0007-x",
            Path::new("/Users/me/.canopy/bin/canopy-hook"),
            &job,
            Civil {
                year: 2026,
                month: 8,
                day: 3,
                hour: 9,
                minute: 5,
            },
        );
        assert!(
            out.contains("Fix &lt;Markdown&gt; &amp; the parser"),
            "{out}"
        );
        assert!(out.contains("canopy://note?id=p1&amp;note=0007-x"), "{out}");
        assert!(out.contains("<key>Hour</key><integer>9</integer>"), "{out}");
        assert!(
            out.contains("<key>Minute</key><integer>5</integer>"),
            "{out}"
        );
        assert!(
            out.contains("<key>Month</key><integer>8</integer>"),
            "{out}"
        );
        assert!(out.contains("<key>Day</key><integer>3</integer>"), "{out}");
        // The helper must be argv[0] and the mode must be there, or the job
        // loads and does nothing at the due minute.
        assert!(
            out.contains("<string>/Users/me/.canopy/bin/canopy-hook</string>"),
            "{out}"
        );
        assert!(out.contains("<string>--remind</string>"), "{out}");
        // Without --app the helper has nowhere to send the click.
        assert!(out.contains("<string>--app</string>"), "{out}");
        // RunAtLoad would fire every reminder the moment it was set.
        assert!(out.contains("<key>RunAtLoad</key>\n  <false/>"), "{out}");
    }
}
