//! Whole-app resource footprint for the status bar chip.
//!
//! Canopy's own process tree (the Rust core, language servers, terminals and
//! everything they spawn) is easy to walk: start at our pid and follow parent
//! links down. On Windows and Linux the WebView helpers are descendants too.
//! On macOS they are not: WKWebView's WebContent, GPU and Networking processes
//! are XPC services that launchd parents, so a tree walk misses them, and they
//! are usually the largest part of the app (the WebContent process alone can
//! be several times the size of everything else).
//!
//! macOS does record who those helpers work for. Every process has a
//! "responsible" pid, the one TCC, Activity Monitor and `lsappinfo` charge it
//! to. A WebContent process launched for Canopy is responsible to Canopy; one
//! launched for Safari is responsible to Safari. We attribute exactly the
//! processes whose responsible pid is ours, and nothing else.

use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// CPU, memory and process count for one slice of the app.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct AppStatsPart {
    pub cpu: f32,
    pub mem_bytes: u64,
    pub procs: u32,
}

impl AppStatsPart {
    fn add(&mut self, cpu: f32, mem_bytes: u64) {
        self.cpu += cpu;
        self.mem_bytes += mem_bytes;
        self.procs += 1;
    }
}

/// App resource usage, totalled and broken down.
///
/// `includes_webviews` is false when the WebView helpers could not be
/// attributed (macOS without the responsibility API, or a launch where macOS
/// charges the helpers to something else, such as a dev build started from a
/// terminal). The total is then a lower bound and the frontend says so.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct AppStats {
    pub cpu: f32,
    pub mem_bytes: u64,
    pub procs: u32,
    pub includes_webviews: bool,
    /// The Canopy process itself.
    pub core: AppStatsPart,
    /// WebView helpers: macOS WebKit XPC services (and the small system XPC
    /// helpers macOS launches on Canopy's behalf), or the WebView2 / WebKitGTK
    /// child processes elsewhere.
    pub webviews: AppStatsPart,
    /// Everything else Canopy spawned: terminals, agents, language servers,
    /// dev servers and their children.
    pub children: AppStatsPart,
}

/// One process as the aggregation sees it. Memory is the fallback figure
/// (RSS); the caller's `mem_of` may replace it with a better one.
#[derive(Clone, Debug)]
pub struct AppProc<'a> {
    pub pid: u32,
    pub parent: Option<u32>,
    pub name: &'a str,
    pub cpu: f32,
    pub mem_bytes: u64,
    /// The pid macOS charges this process to. `None` when unknown.
    pub responsible: Option<u32>,
}

/// WebView helper processes that are ordinary descendants of the app: WebView2
/// on Windows, WebKitGTK on Linux, and the WebKit XPC names for completeness.
pub fn is_webview_helper(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("com.apple.webkit.")
        || lower.starts_with("msedgewebview2")
        || lower.starts_with("webkitwebprocess")
        || lower.starts_with("webkitnetworkprocess")
        || lower.starts_with("webkitgpuprocess")
}

/// Total the app's footprint from a process listing.
///
/// - `self_pid` is the Canopy core.
/// - Descendants of the core are children, except WebView helpers, which go
///   to `webviews`.
/// - Non-descendants count only when their responsible pid is `self_pid`
///   (macOS XPC services launched for us). They go to `webviews`.
/// - `external_webviews` says the platform hosts WebView helpers outside the
///   tree (macOS). Then `includes_webviews` is true only once a WebKit helper
///   was actually attributed; otherwise the tree already holds them.
pub fn aggregate(
    self_pid: u32,
    procs: &[AppProc<'_>],
    external_webviews: bool,
    mut mem_of: impl FnMut(&AppProc<'_>) -> u64,
) -> AppStats {
    let mut children: HashMap<u32, Vec<usize>> = HashMap::new();
    let mut by_pid: HashMap<u32, usize> = HashMap::new();
    for (i, p) in procs.iter().enumerate() {
        by_pid.insert(p.pid, i);
        if let Some(parent) = p.parent {
            if parent != p.pid {
                children.entry(parent).or_default().push(i);
            }
        }
    }

    let mut stats = AppStats::default();
    let mut counted: HashSet<u32> = HashSet::new();
    let mut found_webkit = false;

    // The native tree: core plus every descendant.
    let mut queue: Vec<u32> = vec![self_pid];
    while let Some(pid) = queue.pop() {
        if !counted.insert(pid) {
            continue; // cycles are impossible in theory, cheap to rule out
        }
        if let Some(&i) = by_pid.get(&pid) {
            let p = &procs[i];
            let mem = mem_of(p);
            if pid == self_pid {
                stats.core.add(p.cpu, mem);
            } else if is_webview_helper(p.name) {
                stats.webviews.add(p.cpu, mem);
            } else {
                stats.children.add(p.cpu, mem);
            }
        }
        if let Some(kids) = children.get(&pid) {
            queue.extend(kids.iter().map(|&i| procs[i].pid));
        }
    }

    // Processes outside the tree that macOS charges to us.
    for p in procs {
        if p.responsible != Some(self_pid) || counted.contains(&p.pid) {
            continue;
        }
        counted.insert(p.pid);
        if is_webview_helper(p.name) {
            found_webkit = true;
        }
        let mem = mem_of(p);
        stats.webviews.add(p.cpu, mem);
    }

    for part in [stats.core, stats.webviews, stats.children] {
        stats.cpu += part.cpu;
        stats.mem_bytes += part.mem_bytes;
        stats.procs += part.procs;
    }
    stats.includes_webviews = !external_webviews || found_webkit;
    stats
}

/// The pid macOS holds responsible for `pid`, via libsystem's
/// `responsibility_get_pid_responsible_for_pid`. It is not in a public header,
/// so it is resolved at runtime: a macOS without it degrades to the native tree
/// rather than failing to launch.
#[cfg(target_os = "macos")]
pub fn responsible_pid(pid: u32) -> Option<u32> {
    use std::sync::OnceLock;
    type Responsible = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;
    static FUNC: OnceLock<Option<Responsible>> = OnceLock::new();
    let func = FUNC.get_or_init(|| {
        // SAFETY: dlsym with RTLD_DEFAULT and a NUL-terminated name is always
        // sound; a null result means the symbol is absent.
        let sym = unsafe {
            libc::dlsym(
                libc::RTLD_DEFAULT,
                c"responsibility_get_pid_responsible_for_pid".as_ptr(),
            )
        };
        if sym.is_null() {
            None
        } else {
            // SAFETY: the symbol has this signature in every macOS that ships
            // it: pid_t responsibility_get_pid_responsible_for_pid(pid_t).
            Some(unsafe { std::mem::transmute::<*mut libc::c_void, Responsible>(sym) })
        }
    });
    let func = (*func)?;
    // SAFETY: plain syscall wrapper; any pid is a valid argument.
    let responsible = unsafe { func(pid as libc::pid_t) };
    (responsible > 0).then_some(responsible as u32)
}

#[cfg(not(target_os = "macos"))]
pub fn responsible_pid(_pid: u32) -> Option<u32> {
    None
}

/// Responsible pids, cached per process lifetime. A process's responsible pid
/// is fixed at launch, so each pid is asked once (keyed with its start time so
/// a recycled pid is asked again), keeping the 2s poll as cheap as it was.
#[derive(Default)]
pub struct ResponsibleCache {
    entries: HashMap<u32, (u64, Option<u32>)>,
}

impl ResponsibleCache {
    pub fn get(
        &mut self,
        pid: u32,
        start_time: u64,
        lookup: impl FnOnce(u32) -> Option<u32>,
    ) -> Option<u32> {
        match self.entries.get(&pid) {
            Some(&(start, responsible)) if start == start_time => responsible,
            _ => {
                let responsible = lookup(pid);
                self.entries.insert(pid, (start_time, responsible));
                responsible
            }
        }
    }

    /// Forget processes that no longer exist.
    pub fn retain(&mut self, live: impl Fn(u32) -> bool) {
        self.entries.retain(|&pid, _| live(pid));
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CANOPY: u32 = 100;
    const SAFARI: u32 = 200;
    const LAUNCHD: u32 = 1;

    fn proc_(
        pid: u32,
        parent: u32,
        name: &'static str,
        mem: u64,
        responsible: u32,
    ) -> AppProc<'static> {
        AppProc {
            pid,
            parent: Some(parent),
            name,
            cpu: 1.0,
            mem_bytes: mem,
            responsible: Some(responsible),
        }
    }

    fn macos_listing() -> Vec<AppProc<'static>> {
        vec![
            proc_(LAUNCHD, 0, "launchd", 10, LAUNCHD),
            proc_(CANOPY, LAUNCHD, "canopy", 300, CANOPY),
            proc_(101, CANOPY, "zsh", 5, CANOPY),
            proc_(102, 101, "claude", 40, CANOPY),
            proc_(103, CANOPY, "rust-analyzer", 3, CANOPY),
            // Canopy's WebKit helpers: launchd children, responsible to Canopy.
            proc_(110, LAUNCHD, "com.apple.WebKit.WebContent", 1_100, CANOPY),
            proc_(111, LAUNCHD, "com.apple.WebKit.GPU", 21, CANOPY),
            proc_(112, LAUNCHD, "com.apple.WebKit.Networking", 5, CANOPY),
            proc_(113, LAUNCHD, "com.apple.audio.SandboxHelper", 1, CANOPY),
            // Safari's: identical names, must not count.
            proc_(SAFARI, LAUNCHD, "Safari", 900, SAFARI),
            proc_(210, LAUNCHD, "com.apple.WebKit.WebContent", 2_000, SAFARI),
            proc_(211, LAUNCHD, "com.apple.WebKit.GPU", 80, SAFARI),
        ]
    }

    #[test]
    fn macos_attributes_only_webkit_helpers_responsible_to_canopy() {
        let stats = aggregate(CANOPY, &macos_listing(), true, |p| p.mem_bytes);
        assert_eq!(
            stats.core,
            AppStatsPart {
                cpu: 1.0,
                mem_bytes: 300,
                procs: 1
            }
        );
        assert_eq!(stats.children.mem_bytes, 48);
        assert_eq!(stats.children.procs, 3);
        assert_eq!(stats.webviews.mem_bytes, 1_100 + 21 + 5 + 1);
        assert_eq!(stats.webviews.procs, 4);
        assert_eq!(stats.mem_bytes, 300 + 48 + 1_127);
        assert_eq!(stats.procs, 8);
        assert!((stats.cpu - 8.0).abs() < f32::EPSILON);
        assert!(stats.includes_webviews);
    }

    #[test]
    fn macos_without_attribution_is_a_lower_bound() {
        let mut listing = macos_listing();
        for p in &mut listing {
            p.responsible = None;
        }
        let stats = aggregate(CANOPY, &listing, true, |p| p.mem_bytes);
        assert_eq!(stats.webviews, AppStatsPart::default());
        assert_eq!(stats.mem_bytes, 348);
        assert!(!stats.includes_webviews);
    }

    #[test]
    fn responsible_non_webkit_helpers_alone_do_not_claim_webviews() {
        let listing: Vec<_> = macos_listing()
            .into_iter()
            .filter(|p| !p.name.starts_with("com.apple.WebKit") || p.responsible != Some(CANOPY))
            .collect();
        let stats = aggregate(CANOPY, &listing, true, |p| p.mem_bytes);
        assert_eq!(stats.webviews.procs, 1); // the audio helper still counts
        assert!(!stats.includes_webviews);
    }

    #[test]
    fn descendants_responsible_to_canopy_are_counted_once() {
        // Terminal children are responsible to Canopy too; the tree walk owns them.
        let stats = aggregate(CANOPY, &macos_listing(), true, |p| p.mem_bytes);
        assert_eq!(stats.children.procs, 3);
        assert_eq!(
            stats.procs,
            stats.core.procs + stats.children.procs + stats.webviews.procs
        );
    }

    #[test]
    fn webview_children_in_the_tree_are_split_out_elsewhere() {
        let listing = vec![
            proc_(CANOPY, LAUNCHD, "canopy.exe", 200, CANOPY),
            proc_(101, CANOPY, "msedgewebview2.exe", 400, CANOPY),
            proc_(102, 101, "msedgewebview2.exe", 300, CANOPY),
            proc_(103, CANOPY, "pwsh.exe", 50, CANOPY),
        ];
        let stats = aggregate(CANOPY, &listing, false, |p| p.mem_bytes);
        assert_eq!(stats.webviews.mem_bytes, 700);
        assert_eq!(stats.children.mem_bytes, 50);
        assert_eq!(stats.mem_bytes, 950);
        assert!(stats.includes_webviews);
    }

    #[test]
    fn mem_of_replaces_the_fallback_figure() {
        let stats = aggregate(CANOPY, &macos_listing(), true, |p| p.mem_bytes * 2);
        assert_eq!(stats.mem_bytes, 2 * (300 + 48 + 1_127));
    }

    #[test]
    fn a_parent_cycle_cannot_hang_the_walk() {
        let listing = vec![
            proc_(CANOPY, 102, "canopy", 1, CANOPY),
            proc_(101, CANOPY, "a", 1, CANOPY),
            proc_(102, 101, "b", 1, CANOPY),
        ];
        let stats = aggregate(CANOPY, &listing, false, |p| p.mem_bytes);
        assert_eq!(stats.procs, 3);
    }

    #[test]
    fn responsible_cache_asks_once_per_process_lifetime() {
        let mut cache = ResponsibleCache::default();
        let mut asked = 0;
        let mut ask = |pid: u32| {
            asked += 1;
            Some(pid + 1)
        };
        assert_eq!(cache.get(5, 10, &mut ask), Some(6));
        assert_eq!(cache.get(5, 10, &mut ask), Some(6));
        // Same pid, new start time: a recycled pid is asked again.
        assert_eq!(cache.get(5, 11, &mut ask), Some(6));
        assert_eq!(asked, 2);
        cache.get(6, 1, |_| None);
        cache.retain(|pid| pid == 6);
        assert_eq!(cache.len(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn our_own_process_is_responsible_to_something() {
        // The API resolves on every supported macOS; the exact owner depends
        // on how the test was launched, so only its presence is asserted.
        assert!(responsible_pid(std::process::id()).is_some());
    }
}
