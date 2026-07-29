//! Android devices: the SDK behind them, the frames they show, and the
//! structure an agent reads off one.
//!
//! Everything here shells out to exactly two tools — `adb` and the `android`
//! CLI — and nothing else. That is deliberate, and it is what makes the feature
//! work identically on macOS, Windows and Linux: the only device-side component
//! is Android's own, and neither tool needs a per-platform binary of ours.
//!
//! The frames are still pictures (`screencap`), not video. An agent drives the
//! device and the user watches; nobody manipulates the picture directly, so
//! there is nothing here to decode. That is the whole reason this module has no
//! codec, no vendored server, and no platform matrix — see `screencap` below.
//!
//! Frame delivery is pull, not push: the frontend asks for a picture when it
//! wants one. A push loop would need start/stop plumbing and a bounded-lossy
//! queue to stop a slow consumer backing up the producer; one request in flight
//! gives both properties for free, and a hidden tab simply stops asking.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::winproc::NoConsoleWindow;

/// Where the tools live. Resolved per call rather than cached in a global: a
/// workspace can hold several Android projects, and `local.properties` makes
/// the SDK a property of the project, not of the machine.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Sdk {
    pub root: String,
    pub adb: String,
    /// The `android` CLI, absent when cmdline-tools was never installed. Device
    /// work still runs without it; project and emulator work does not.
    pub cli: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SdkStatus {
    pub sdk: Option<Sdk>,
    /// What to install, in the user's words rather than a path that failed.
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Device {
    pub serial: String,
    /// `device`, `offline`, `unauthorized` — adb's own word for it.
    pub state: String,
    pub model: String,
    /// An emulator (serial `emulator-NNNN`) rather than something plugged in.
    pub emulator: bool,
}

const EXE: &str = if cfg!(windows) { ".exe" } else { "" };
const BAT: &str = if cfg!(windows) { ".bat" } else { "" };

/// The SDK root, most specific source first.
///
/// `local.properties` wins over the environment because that is the order
/// Gradle itself resolves in — a project pinned to a particular SDK must not
/// silently build against whichever one the shell happens to export.
fn sdk_root(project_dir: Option<&str>) -> Option<PathBuf> {
    if let Some(dir) = project_dir {
        if let Some(root) = sdk_dir_from_local_properties(Path::new(dir)) {
            return Some(root);
        }
    }
    for key in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Ok(v) = std::env::var(key) {
            let p = PathBuf::from(v);
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    default_sdk_root().filter(|p| p.is_dir())
}

/// Where Android Studio puts the SDK when nobody has moved it.
fn default_sdk_root() -> Option<PathBuf> {
    let home = dirs_home()?;
    Some(if cfg!(target_os = "macos") {
        home.join("Library/Android/sdk")
    } else if cfg!(windows) {
        // LOCALAPPDATA rather than the profile root; the installer has used it
        // since Studio 3.x and it is the only location on Windows.
        std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join("AppData/Local"))
            .join("Android/Sdk")
    } else {
        home.join("Android/Sdk")
    })
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(PathBuf::from)
}

/// `sdk.dir=…` out of a Gradle project's `local.properties`.
pub fn sdk_dir_from_local_properties(project_dir: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(project_dir.join("local.properties")).ok()?;
    let raw = parse_sdk_dir(&text)?;
    let p = PathBuf::from(raw);
    p.is_dir().then_some(p)
}

/// Gradle escapes `:` and `\` in this file, so the value needs unescaping
/// before it is a path — on Windows every separator arrives as `\\`.
fn parse_sdk_dir(text: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.starts_with('!') {
            continue;
        }
        let Some(rest) = line.strip_prefix("sdk.dir") else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(value) = rest.strip_prefix('=') else {
            continue;
        };
        let value = value.trim().replace("\\:", ":").replace("\\\\", "\\");
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

/// Resolve the tools, or say which one is missing.
pub fn resolve(project_dir: Option<&str>) -> SdkStatus {
    let Some(root) = sdk_root(project_dir) else {
        return SdkStatus {
            sdk: None,
            missing: vec![
                "the Android SDK — install Android Studio, or set ANDROID_HOME to an existing SDK"
                    .into(),
            ],
        };
    };
    let adb = root.join("platform-tools").join(format!("adb{EXE}"));
    let cli = root
        .join("cmdline-tools/latest/bin")
        .join(format!("android{BAT}"));

    let mut missing = Vec::new();
    // Fall back to PATH: a Homebrew or distro adb talks the same protocol, and
    // refusing to work because it sits outside the SDK helps nobody.
    let adb = if adb.is_file() {
        adb.to_string_lossy().to_string()
    } else {
        let onpath = crate::git::tool_path("adb");
        if onpath == "adb" {
            missing
                .push("platform-tools (adb) — install it from Android Studio's SDK Manager".into());
        }
        onpath
    };
    if !cli.is_file() {
        missing.push(
            "cmdline-tools — needed to create and start emulators and to read the project; \
             install \"Android SDK Command-line Tools (latest)\" from Android Studio's SDK Manager"
                .into(),
        );
    }

    SdkStatus {
        sdk: Some(Sdk {
            root: root.to_string_lossy().to_string(),
            adb,
            cli: cli.is_file().then(|| cli.to_string_lossy().to_string()),
        }),
        missing,
    }
}

fn sdk_or_err(project_dir: Option<&str>) -> Result<Sdk, String> {
    let status = resolve(project_dir);
    match status.sdk {
        Some(sdk) => Ok(sdk),
        None => Err(status.missing.join("; ")),
    }
}

fn cli_or_err(sdk: &Sdk) -> Result<&str, String> {
    sdk.cli.as_deref().ok_or_else(|| {
        "the Android command-line tools aren't installed — add \"Android SDK Command-line \
         Tools (latest)\" in Android Studio's SDK Manager"
            .to_string()
    })
}

fn run(cmd: &mut Command) -> Result<String, String> {
    let out = cmd
        .no_console_window()
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).to_string());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Err(if err.is_empty() { stdout } else { err })
}

fn adb(sdk: &Sdk, serial: Option<&str>) -> Command {
    let mut cmd = Command::new(&sdk.adb);
    if let Some(s) = serial {
        cmd.arg("-s").arg(s);
    }
    cmd.no_console_window();
    cmd
}

// ---------- devices ----------

/// Everything adb can see, parsed from `devices -l`.
pub fn devices(sdk: &Sdk) -> Result<Vec<Device>, String> {
    let out = run(adb(sdk, None).args(["devices", "-l"]))?;
    Ok(parse_devices(&out))
}

fn parse_devices(out: &str) -> Vec<Device> {
    let mut list = Vec::new();
    for line in out
        .lines()
        .skip_while(|l| !l.starts_with("List of devices"))
    {
        let line = line.trim();
        if line.is_empty() || line.starts_with("List of devices") {
            continue;
        }
        let mut parts = line.split_whitespace();
        let (Some(serial), Some(state)) = (parts.next(), parts.next()) else {
            continue;
        };
        let model = parts
            .find_map(|p| p.strip_prefix("model:"))
            .unwrap_or_default()
            .replace('_', " ");
        list.push(Device {
            serial: serial.to_string(),
            state: state.to_string(),
            model,
            emulator: serial.starts_with("emulator-"),
        });
    }
    list
}

#[tauri::command]
pub fn android_sdk_status(project_dir: Option<String>) -> SdkStatus {
    resolve(project_dir.as_deref())
}

#[tauri::command]
pub fn android_devices(project_dir: Option<String>) -> Result<Vec<Device>, String> {
    devices(&sdk_or_err(project_dir.as_deref())?)
}

// ---------- emulators ----------

#[tauri::command]
pub fn android_avds(project_dir: Option<String>) -> Result<Vec<Avd>, String> {
    let sdk = sdk_or_err(project_dir.as_deref())?;
    let out = run(Command::new(cli_or_err(&sdk)?).args(["emulator", "list"]))?;
    Ok(out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|name| {
            let problem = avd_problem(&sdk, name);
            Avd {
                name: name.to_string(),
                ready: problem.is_none(),
                problem,
            }
        })
        .collect())
}

/// An emulator, and whether it can actually boot.
///
/// Checked up front because the alternative is worse than useless: `android
/// emulator start` on an AVD whose system image is gone **exits 0**, prints
/// "Emulator process has exited early", and reports no serial — so the only
/// honest thing a caller could say afterwards is that something went wrong
/// somewhere. Offering a button that cannot work, and then explaining the
/// failure badly, is two bugs; this removes both.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Avd {
    pub name: String,
    pub ready: bool,
    /// Why it can't boot, in the user's terms. `None` when it can.
    pub problem: Option<String>,
}

/// The AVD's `image.sysdir.1`, resolved against the SDK. Missing means the
/// system image was never installed or has since been removed.
fn avd_problem(sdk: &Sdk, name: &str) -> Option<String> {
    let config = avd_home().join(format!("{name}.avd")).join("config.ini");
    let text = std::fs::read_to_string(config).ok()?;
    let sysdir = text.lines().find_map(|l| {
        l.trim()
            .strip_prefix("image.sysdir.1")?
            .trim_start()
            .strip_prefix('=')
            .map(|v| v.trim().to_string())
    })?;
    // Relative to the SDK root, which is how the emulator resolves it.
    if Path::new(&sdk.root).join(&sysdir).is_dir() {
        return None;
    }
    Some(format!(
        "its system image is missing ({sysdir}) — install it in Android Studio's SDK Manager, \
         or delete this device and create a new one"
    ))
}

/// Where AVDs live. `ANDROID_AVD_HOME` wins, then `ANDROID_SDK_HOME`, then the
/// default — the same order the emulator itself resolves in.
fn avd_home() -> PathBuf {
    if let Ok(dir) = std::env::var("ANDROID_AVD_HOME") {
        return PathBuf::from(dir);
    }
    let base = std::env::var("ANDROID_SDK_HOME")
        .map(PathBuf::from)
        .ok()
        .or_else(dirs_home)
        .unwrap_or_default();
    base.join(".android").join("avd")
}

/// Boot an AVD and return its serial.
///
/// `android emulator start` blocks until the device is actually usable and then
/// prints the serial, so there is no boot-polling loop here and no window where
/// we hand back a serial that would reject the next command.
#[tauri::command]
pub async fn android_emulator_start(
    project_dir: Option<String>,
    name: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sdk = sdk_or_err(project_dir.as_deref())?;
        // Refuse before spawning when we already know why it can't work; the
        // CLI's own failure for this case is a success exit code and a shrug.
        if let Some(problem) = avd_problem(&sdk, &name) {
            return Err(format!("{name} can't start: {problem}"));
        }
        let out = run(Command::new(cli_or_err(&sdk)?).args(["emulator", "start", &name]))?;
        if let Some(serial) = parse_started_serial(&out) {
            return Ok(serial);
        }
        Err(format!(
            "{name} didn't start: {}",
            start_failure(&name, &out)
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Why a start produced no serial. The CLI exits 0 either way and keeps the
/// reason in the AVD's own log, so that is where to look before falling back to
/// whatever it did print.
fn start_failure(name: &str, out: &str) -> String {
    let log = avd_home().join(format!("{name}.avd"));
    let log = log
        .parent()
        .map(|p| p.join(name).join("emulator.log"))
        .unwrap_or_default();
    // The emulator writes its log beside the AVD under ~/.android/<name>/.
    let log = if log.is_file() {
        log
    } else {
        dirs_home()
            .unwrap_or_default()
            .join(".android")
            .join(name)
            .join("emulator.log")
    };
    if let Ok(text) = std::fs::read_to_string(&log) {
        let fatal: Vec<&str> = text
            .lines()
            .filter(|l| l.contains("FATAL") || l.contains("ERROR"))
            .rev()
            .take(2)
            .collect();
        if !fatal.is_empty() {
            return fatal
                .into_iter()
                .rev()
                .map(|l| l.split('|').next_back().unwrap_or(l).trim())
                .collect::<Vec<_>>()
                .join("; ");
        }
    }
    let said = out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("Waiting for"))
        .next_back()
        .unwrap_or("");
    if said.is_empty() {
        format!("no reason given (see {})", log.display())
    } else {
        said.to_string()
    }
}

/// The serial out of "Virtual device successfully started as 'emulator-5554'".
fn parse_started_serial(out: &str) -> Option<String> {
    out.lines().rev().find_map(|line| {
        let start = line.find("emulator-")?;
        let serial: String = line[start..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect();
        (serial.len() > "emulator-".len()).then_some(serial)
    })
}

#[tauri::command]
pub async fn android_emulator_stop(
    project_dir: Option<String>,
    serial: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sdk = sdk_or_err(project_dir.as_deref())?;
        run(Command::new(cli_or_err(&sdk)?).args(["emulator", "stop", &serial]))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- frames ----------

/// A PNG of what the device is showing, as raw bytes.
///
/// PNG rather than `screencap`'s raw RGBA: raw skips the on-device encode and
/// measures faster on an emulator, but it is ~10 MB a frame against ~1.4 MB, and
/// over a real USB cable that transfer is the whole cost.
///
/// Returned as `Response` so the bytes reach the webview as an ArrayBuffer
/// rather than a base64 string — the same raw-bytes contract the PTY channel
/// uses, for the same reason.
pub async fn screencap_bytes(
    project_dir: Option<String>,
    serial: String,
) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sdk = sdk_or_err(project_dir.as_deref())?;
        let out = adb(&sdk, Some(&serial))
            .args(["exec-out", "screencap", "-p"])
            .no_console_window()
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        if out.stdout.is_empty() {
            return Err("the device returned an empty screenshot".to_string());
        }
        Ok(out.stdout)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn android_screencap(
    project_dir: Option<String>,
    serial: String,
) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(
        screencap_bytes(project_dir, serial).await?,
    ))
}

/// The device an op should target when the caller named none: the only one
/// attached. Anything else is ambiguous, and guessing which phone to tap is a
/// worse failure than asking.
pub fn only_device(project_dir: Option<&str>) -> Result<String, String> {
    let sdk = sdk_or_err(project_dir)?;
    let ready: Vec<Device> = devices(&sdk)?
        .into_iter()
        .filter(|d| d.state == "device")
        .collect();
    match ready.len() {
        0 => Err(
            "no Android device is attached — start an emulator, or plug in a device with \
                  USB debugging enabled"
                .into(),
        ),
        1 => Ok(ready[0].serial.clone()),
        _ => Err(format!(
            "several devices are attached; pass one of: {}",
            ready
                .iter()
                .map(|d| d.serial.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

// ---------- structure ----------

/// The accessibility tree as uiautomator's XML.
///
/// Preferred over `android layout` for anything positional: both read the same
/// tree and their coordinates agree exactly, but `layout` drops `bounds` on all
/// but the root node, and hit-testing a click needs rectangles.
#[tauri::command]
pub async fn android_ui_dump(
    project_dir: Option<String>,
    serial: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sdk = sdk_or_err(project_dir.as_deref())?;
        let remote = "/sdcard/canopy-ui-dump.xml";
        run(adb(&sdk, Some(&serial)).args(["shell", "uiautomator", "dump", remote]))?;
        let xml = run(adb(&sdk, Some(&serial)).args(["exec-out", "cat", remote]))?;
        if !xml.contains("<hierarchy") {
            return Err(format!(
                "the device didn't return a UI hierarchy: {}",
                xml.trim()
            ));
        }
        Ok(xml)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The same tree as the `android` CLI's JSON, which is what an agent reads.
#[tauri::command]
pub async fn android_layout(project_dir: Option<String>, serial: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sdk = sdk_or_err(project_dir.as_deref())?;
        run(Command::new(cli_or_err(&sdk)?).args(["layout", "--pretty", "--device", &serial]))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The package and activity in front, so a caller can tell whether the app it
/// launched is actually what it is looking at.
#[tauri::command]
pub async fn android_foreground(
    project_dir: Option<String>,
    serial: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sdk = sdk_or_err(project_dir.as_deref())?;
        let out = run(adb(&sdk, Some(&serial)).args(["shell", "dumpsys", "window", "windows"]))
            .or_else(|_| run(adb(&sdk, Some(&serial)).args(["shell", "dumpsys", "window"])))?;
        Ok(parse_focus(&out).unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn parse_focus(out: &str) -> Option<String> {
    let line = out.lines().find(|l| l.contains("mCurrentFocus"))?;
    let start = line.find('{')? + 1;
    let inner = &line[start..];
    let end = inner.find('}').unwrap_or(inner.len());
    inner[..end]
        .split_whitespace()
        .find(|t| t.contains('/'))
        .map(str::to_string)
}

// ---------- input ----------

/// `adb shell input` runs a shell ON THE DEVICE, so the text argument is
/// shell-interpreted there. Spaces become `%s` (what `input text` expects) and
/// everything the device shell would otherwise act on is backslash-escaped.
fn escape_input_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            ' ' => out.push_str("%s"),
            '%' => out.push_str("\\%"),
            '\\' | '"' | '\'' | '`' | '$' | '&' | '|' | ';' | '(' | ')' | '<' | '>' | '*' | '?'
            | '[' | ']' | '{' | '}' | '~' | '#' | '!' => {
                out.push('\\');
                out.push(c);
            }
            '\n' => out.push(' '),
            _ => out.push(c),
        }
    }
    out
}

#[tauri::command]
pub async fn android_tap(
    project_dir: Option<String>,
    serial: String,
    x: i32,
    y: i32,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sdk = sdk_or_err(project_dir.as_deref())?;
        run(adb(&sdk, Some(&serial)).args([
            "shell",
            "input",
            "tap",
            &x.to_string(),
            &y.to_string(),
        ]))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn android_text(
    project_dir: Option<String>,
    serial: String,
    text: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sdk = sdk_or_err(project_dir.as_deref())?;
        run(adb(&sdk, Some(&serial)).args(["shell", "input", "text", &escape_input_text(&text)]))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn android_swipe(
    project_dir: Option<String>,
    serial: String,
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
    ms: Option<u32>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sdk = sdk_or_err(project_dir.as_deref())?;
        run(adb(&sdk, Some(&serial)).args([
            "shell",
            "input",
            "swipe",
            &x1.to_string(),
            &y1.to_string(),
            &x2.to_string(),
            &y2.to_string(),
            &ms.unwrap_or(300).to_string(),
        ]))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A named key (`BACK`, `HOME`, `ENTER`, …). Restricted to the keyevent name
/// shape so the argument can never become another `input` subcommand.
#[tauri::command]
pub async fn android_key(
    project_dir: Option<String>,
    serial: String,
    key: String,
) -> Result<(), String> {
    if !is_keyevent_name(&key) {
        return Err(format!("{key} isn't a keyevent name"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let sdk = sdk_or_err(project_dir.as_deref())?;
        run(adb(&sdk, Some(&serial)).args(["shell", "input", "keyevent", &key]))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn is_keyevent_name(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 48
        && key
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

// ---------- logs ----------

/// The app's own logcat — the console analogue. Filtered to the package's pid
/// so an agent reads its app's output, not the whole system's.
#[tauri::command]
pub async fn android_logcat(
    project_dir: Option<String>,
    serial: String,
    package: Option<String>,
    lines: Option<u32>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sdk = sdk_or_err(project_dir.as_deref())?;
        let max = lines.unwrap_or(200).clamp(1, 5000).to_string();
        let mut args: Vec<String> = vec!["logcat".into(), "-d".into(), "-t".into(), max];
        if let Some(pkg) = package.as_deref().filter(|p| !p.is_empty()) {
            let pid = run(adb(&sdk, Some(&serial)).args(["shell", "pidof", "-s", pkg]))
                .unwrap_or_default()
                .trim()
                .to_string();
            if pid.is_empty() {
                return Err(format!("{pkg} isn't running on {serial}"));
            }
            args.push(format!("--pid={pid}"));
        }
        run(adb(&sdk, Some(&serial)).args(&args))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- build and launch ----------

/// The project's build targets and where their APKs land.
#[tauri::command]
pub async fn android_describe(project_dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sdk = sdk_or_err(Some(&project_dir))?;
        run(Command::new(cli_or_err(&sdk)?)
            .args(["describe", &format!("--project_dir={project_dir}")])
            .current_dir(&project_dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Install an APK and launch it. `android run` picks the launcher activity
/// itself, so callers don't have to parse the manifest to start an app.
#[tauri::command]
pub async fn android_run(
    project_dir: String,
    apk: String,
    serial: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sdk = sdk_or_err(Some(&project_dir))?;
        run(Command::new(cli_or_err(&sdk)?)
            .args([
                "run",
                &format!("--apks={apk}"),
                &format!("--device={serial}"),
            ])
            .current_dir(&project_dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_sdk_dir_out_of_local_properties() {
        let text = "## generated\n# comment\nsdk.dir=/Users/x/Library/Android/sdk\n";
        assert_eq!(
            parse_sdk_dir(text).as_deref(),
            Some("/Users/x/Library/Android/sdk")
        );
    }

    #[test]
    fn unescapes_a_windows_sdk_dir() {
        // Gradle writes the drive colon and every separator escaped.
        let text = "sdk.dir=C\\:\\\\Users\\\\x\\\\AppData\\\\Local\\\\Android\\\\Sdk\n";
        assert_eq!(
            parse_sdk_dir(text).as_deref(),
            Some(r"C:\Users\x\AppData\Local\Android\Sdk")
        );
    }

    #[test]
    fn ignores_comments_and_other_keys() {
        assert_eq!(parse_sdk_dir("#sdk.dir=/nope\nndk.dir=/x\n"), None);
    }

    #[test]
    fn parses_adb_devices_with_no_devices() {
        assert!(parse_devices("List of devices attached\n\n").is_empty());
    }

    #[test]
    fn parses_an_emulator_and_a_handset() {
        let out = "List of devices attached\n\
                   emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a\n\
                   39081FDJH00123         unauthorized usb:1234\n";
        let list = parse_devices(out);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].serial, "emulator-5554");
        assert_eq!(list[0].state, "device");
        assert_eq!(list[0].model, "sdk gphone64 arm64");
        assert!(list[0].emulator);
        assert_eq!(list[1].state, "unauthorized");
        assert!(!list[1].emulator);
    }

    #[test]
    fn skips_the_daemon_chatter_adb_prints_on_first_run() {
        let out = "* daemon not running; starting now at tcp:5037\n\
                   * daemon started successfully\n\
                   List of devices attached\n\
                   emulator-5554          device\n";
        let list = parse_devices(out);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].serial, "emulator-5554");
    }

    #[test]
    fn finds_the_serial_the_emulator_reports() {
        let out = "Emulator process 69807 started, log file location: '/x/emulator.log'\n\
                   Waiting for virtual device 'medium_phone' to fully start\n\
                   Virtual device successfully started as 'emulator-5554'\n";
        assert_eq!(parse_started_serial(out).as_deref(), Some("emulator-5554"));
    }

    #[test]
    fn reports_no_serial_when_the_emulator_never_said_one() {
        assert_eq!(parse_started_serial("Waiting for virtual device\n"), None);
    }

    #[test]
    fn quotes_what_the_cli_said_when_there_is_no_log_to_read() {
        // The real shape of a failed start: exit 0, no serial, one line of
        // explanation buried after the countdown spam.
        let out = "Emulator process 87132 started, log file location: '/x/emulator.log'\n\
                   Waiting for virtual device 'Broken' to fully start (299 seconds left)\n\
                   Emulator process has exited early, see log for details.\n";
        let said = start_failure("definitely-not-a-real-avd-name", out);
        assert!(said.contains("exited early"), "got: {said}");
        assert!(!said.contains("Waiting for"), "countdown leaked: {said}");
    }

    #[test]
    fn admits_it_has_no_reason_rather_than_inventing_one() {
        let said = start_failure("definitely-not-a-real-avd-name", "Waiting for it\n");
        assert!(said.starts_with("no reason given"), "got: {said}");
    }

    #[test]
    fn reads_the_focused_component() {
        let out = "  mCurrentFocus=Window{a53cac3 u0 the.banana.app/the.banana.app.MainActivity}\n";
        assert_eq!(
            parse_focus(out).as_deref(),
            Some("the.banana.app/the.banana.app.MainActivity")
        );
    }

    #[test]
    fn has_no_focus_on_a_blank_screen() {
        assert_eq!(parse_focus("  mCurrentFocus=null\n"), None);
    }

    #[test]
    fn encodes_spaces_the_way_input_text_expects() {
        assert_eq!(escape_input_text("hello world"), "hello%sworld");
    }

    #[test]
    fn escapes_what_the_device_shell_would_otherwise_act_on() {
        // Without escaping, the device shell would substitute and redirect.
        assert_eq!(escape_input_text("$(rm -rf /)"), "\\$\\(rm%s-rf%s/\\)");
        assert_eq!(escape_input_text("a`b`c"), "a\\`b\\`c");
        assert_eq!(escape_input_text("x>y"), "x\\>y");
    }

    #[test]
    fn keeps_ordinary_text_intact() {
        assert_eq!(escape_input_text("user@example.com"), "user@example.com");
    }

    #[test]
    fn accepts_keyevent_names_and_rejects_anything_else() {
        assert!(is_keyevent_name("BACK"));
        assert!(is_keyevent_name("KEYCODE_DPAD_DOWN"));
        assert!(!is_keyevent_name("back"));
        assert!(!is_keyevent_name("BACK; rm -rf /"));
        assert!(!is_keyevent_name(""));
    }
}
