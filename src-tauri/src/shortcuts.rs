//! Menu accelerators, read from the same manifest the webview reads.
//!
//! `shared/shortcuts.json` is the single definition of every chord in Canopy.
//! It is compiled in with `include_str!`, so a menu item and the webview key
//! handler that backs it up cannot drift apart — and a chord that needs to
//! differ per platform differs in one place instead of two languages.
//!
//! The mirror of this file is `src/shortcuts.ts`; `src/shortcuts.test.ts`
//! asserts the accelerator strings the two produce are identical.

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

const MANIFEST: &str = include_str!("../../shared/shortcuts.json");

/// The platform this binary is being built for. The manifest keys overrides by
/// these names; resolution is compile-time because a build only ever runs on
/// the OS it targets.
const PLATFORM: &str = if cfg!(target_os = "macos") {
    "macos"
} else if cfg!(target_os = "windows") {
    "windows"
} else {
    "linux"
};

#[derive(Deserialize)]
struct Chord {
    mods: Vec<String>,
    key: Option<String>,
}

#[derive(Deserialize)]
struct Shortcut {
    id: String,
    chord: Chord,
    #[serde(default)]
    platform: HashMap<String, Option<Chord>>,
}

#[derive(Deserialize)]
struct ProfileOverride {
    chord: Chord,
    #[serde(default)]
    platform: HashMap<String, Option<Chord>>,
}

#[derive(Deserialize)]
struct Profile {
    #[allow(dead_code)]
    label: String,
    #[allow(dead_code)]
    description: String,
    #[serde(default)]
    overrides: HashMap<String, ProfileOverride>,
}

#[derive(Deserialize)]
struct Manifest {
    profiles: HashMap<String, Profile>,
    shortcuts: Vec<Shortcut>,
}

fn manifest() -> &'static Manifest {
    static PARSED: OnceLock<Manifest> = OnceLock::new();
    // A malformed manifest is a build-time authoring error that would silently
    // strip every accelerator from the menu, so fail loudly instead.
    PARSED.get_or_init(|| {
        serde_json::from_str(MANIFEST).expect("shared/shortcuts.json is not a valid manifest")
    })
}

fn accel_mod(token: &str) -> &'static str {
    match token {
        "Mod" => "CmdOrCtrl",
        "Ctrl" => "Control",
        "Alt" => "Alt",
        "Shift" => "Shift",
        "Meta" => "Super",
        other => panic!("unknown modifier token in shared/shortcuts.json: {other}"),
    }
}

fn accel_key(code: &str) -> String {
    if let Some(rest) = code.strip_prefix("Key") {
        return rest.to_string();
    }
    if let Some(rest) = code.strip_prefix("Digit") {
        return rest.to_string();
    }
    match code {
        "ArrowLeft" => "Left".into(),
        "ArrowRight" => "Right".into(),
        "ArrowUp" => "Up".into(),
        "ArrowDown" => "Down".into(),
        "Comma" => ",".into(),
        "Period" => ".".into(),
        other => other.into(),
    }
}

fn chord_for(id: &str, platform: &str, profile: &str) -> Option<&'static Chord> {
    let s = manifest()
        .shortcuts
        .iter()
        .find(|s| s.id == id)
        .unwrap_or_else(|| panic!("unknown shortcut id: {id}"));
    let profile = manifest()
        .profiles
        .get(profile)
        .unwrap_or_else(|| panic!("unknown shortcut profile: {profile}"));
    let (chord, platform_overrides) = profile
        .overrides
        .get(id)
        .map(|binding| (&binding.chord, &binding.platform))
        .unwrap_or((&s.chord, &s.platform));
    match platform_overrides.get(platform) {
        // Present and null: deliberately unbound on this platform.
        Some(None) => None,
        Some(Some(c)) => Some(c),
        None => Some(chord),
    }
}

fn accelerator_for(id: &str, platform: &str, profile: &str) -> Option<String> {
    let c = chord_for(id, platform, profile)?;
    let key = c.key.as_deref()?;
    // Fixed order so the string is stable and comparable with the TS side.
    let order = ["Ctrl", "Mod", "Alt", "Shift", "Meta"];
    let mut parts: Vec<String> = order
        .iter()
        .filter(|m| c.mods.iter().any(|x| x == *m))
        .map(|m| accel_mod(m).to_string())
        .collect();
    parts.push(accel_key(key));
    Some(parts.join("+"))
}

/// The accelerator for `id` on the platform this binary targets, or `None`
/// when the manifest leaves it unbound here. Panics on an unknown id — a menu
/// item pointing at a shortcut that does not exist is a bug that should stop
/// the build's first run, not quietly ship a menu row with no key.
pub fn accel(id: &str, profile: &str) -> Option<String> {
    accelerator_for(id, PLATFORM, profile)
}

pub fn has_profile(profile: &str) -> bool {
    manifest().profiles.contains_key(profile)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_manifest_parses() {
        assert!(!manifest().shortcuts.is_empty());
    }

    #[test]
    fn mod_becomes_cmdorctrl_and_ctrl_stays_literal() {
        assert_eq!(
            accelerator_for("quick-open", "macos", "canopy").as_deref(),
            Some("CmdOrCtrl+P")
        );
        assert_eq!(
            accelerator_for("next-tab", "macos", "canopy").as_deref(),
            Some("Control+CmdOrCtrl+Right")
        );
    }

    /// The bug this module exists to prevent: off a Mac, `Control+CmdOrCtrl`
    /// collapses to plain Ctrl, which is word-jump in every text field.
    #[test]
    fn tabs_keep_their_keys_and_project_arrows_are_unbound() {
        assert_eq!(
            accelerator_for("next-tab", "windows", "canopy").as_deref(),
            Some("CmdOrCtrl+PageDown")
        );
        assert_eq!(
            accelerator_for("prev-tab", "linux", "canopy").as_deref(),
            Some("CmdOrCtrl+PageUp")
        );
        assert_eq!(accelerator_for("next-project", "windows", "canopy"), None);
    }

    #[test]
    fn an_unbound_platform_has_no_accelerator() {
        assert_eq!(
            accelerator_for("term-line-start", "windows", "canopy"),
            None
        );
        assert!(accelerator_for("term-line-start", "macos", "canopy").is_some());
    }

    /// Every id the menu builder asks for must exist, on every platform we
    /// ship — a typo would otherwise only panic on the OS nobody tested.
    #[test]
    fn every_menu_id_resolves_on_every_platform() {
        for profile in manifest().profiles.keys() {
            for id in crate::MENU_SHORTCUT_IDS {
                for platform in ["macos", "windows", "linux"] {
                    if matches!(*id, "next-project" | "prev-project") {
                        assert!(accelerator_for(id, platform, profile).is_none());
                    } else {
                        assert!(
                            accelerator_for(id, platform, profile).is_some(),
                            "{id} has no accelerator on {platform} in {profile}"
                        );
                    }
                }
            }
        }
    }

    /// Off a Mac there is only one command key. A chord asking for both Mod and
    /// Ctrl resolves to Ctrl+Ctrl — the accelerator reads as a two-modifier
    /// chord but fires on one.
    #[test]
    fn no_off_mac_chord_asks_for_both_mod_and_ctrl() {
        for s in &manifest().shortcuts {
            for platform in ["windows", "linux"] {
                let Some(c) = chord_for(&s.id, platform, "canopy") else {
                    continue;
                };
                let has = |m: &str| c.mods.iter().any(|x| x == m);
                assert!(
                    !(has("Mod") && has("Ctrl")),
                    "{} uses Mod+Ctrl on {platform}, which is Ctrl twice",
                    s.id
                );
            }
        }
    }
}
