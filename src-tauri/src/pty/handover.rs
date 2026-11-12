//! Handing a hosted terminal to a native window, and taking it back.
//!
//! A hosted terminal's child lives in the PTY host, and the host lets one client
//! at a time show it. So "open this terminal in a native window" is a change of
//! who that one client is, and this file keeps the order of it, because the
//! order is what keeps the terminal from being lost or typed into twice:
//!
//! 1. **Release.** This app drops its connection (`HostMaster::detach`) and
//!    removes its session without reporting an exit (`Session::handed_over`).
//!    It writes the terminal into `PtyManager::handed` first, so from then on a
//!    stale close cannot kill it. The session is now attached to nobody, and the
//!    app sends it no input.
//! 2. **Launch.** The window is started to attach to that host session with
//!    `--force`, which would replace this app's client anyway; it is only
//!    needed here if another client got in between.
//! 3. If the launch fails, the app **takes it straight back**, so a failed
//!    hand-over leaves the terminal where it was.
//!
//! **Take back** is an ordinary (non exclusive) attach from offset 0, which the
//! host answers by disconnecting the window's client; the window sees the end of
//! its connection and closes. The new session has the old id and generation, so
//! the tab that showed the terminal shows it again.
//!
//! Nothing of the terminal's identity is let go in between: its bridge
//! credential, claims and sealed metadata stay with the pty id, because the
//! agent in it is still running and still holds them.

use super::*;

/// Said when a terminal cannot be handed over because its child is not in the
/// PTY host (persistent terminals are off, or the host could not be used for
/// this one), or it is not an ordinary terminal tab.
pub(crate) const NOT_HOSTED: &str =
    "This terminal is not kept in the terminal host, so it cannot move to a native window.";

/// What this app keeps of a terminal while a native window holds it: enough to
/// recognise the host's session, and to rebuild the session as it was.
#[derive(Clone, Debug)]
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) struct Handed {
    /// The host's id for the session, and the pid it had: a restarted host
    /// numbers sessions from 1 again, so the id alone proves nothing.
    pub host_id: u32,
    pub pid: u32,
    session_generation: u64,
    kind: SessionKind,
    execution_context: Option<crate::execution::ExecutionContext>,
    command: Option<String>,
    name: String,
    title: String,
    cwd: String,
}

impl Handed {
    /// The terminal's working directory, for the window's own.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn cwd(&self) -> &str {
        &self.cwd
    }
}

/// Where a handed-over terminal is, as the host reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoverState {
    /// A client holds it: the window.
    InWindow,
    /// Nobody holds it: the window was closed. It runs on in the host for its
    /// linger time and can be taken back.
    Detached,
    /// Gone: it exited, the host restarted, or the host no longer lists it.
    Ended,
    /// The host did not answer. Nothing is known, and nothing is changed.
    Unreachable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HandedStatus {
    pub pty_id: u32,
    pub state: HandoverState,
}

/// What the host says about one handed-over terminal. A session counts only
/// under the pid it had, and only while it runs; a host that predates the
/// `attached` field cannot say, which reads as still held by the window.
#[cfg(unix)]
pub(crate) fn state_of(
    handed: &Handed,
    listed: &std::io::Result<Vec<canopy_pty_host::protocol::SessionInfo>>,
) -> HandoverState {
    let Ok(sessions) = listed else {
        return HandoverState::Unreachable;
    };
    match sessions
        .iter()
        .find(|s| s.id == handed.host_id && s.pid == Some(handed.pid))
    {
        Some(s) if s.exited.is_none() => match s.attached {
            Some(false) => HandoverState::Detached,
            _ => HandoverState::InWindow,
        },
        _ => HandoverState::Ended,
    }
}

#[cfg(unix)]
mod hosted {
    use super::*;
    use crate::pty_hosted::{Adoptable, Client, HostedMeta};
    use canopy_pty_host::client::HostMaster;

    /// The host's id for `session`, if it is an ordinary terminal tab whose
    /// child is in the PTY host and still running. Run tabs, micro-tasks and
    /// remote viewers are not ordinary terminal tabs.
    fn hosted_id(session: &Session) -> Option<u32> {
        if !session.survives_quit
            || !matches!(session.kind, SessionKind::Desktop)
            || session.run
            || session.pid.is_none()
            || session.shutdown.load(Ordering::SeqCst)
            || session.eof.load(Ordering::SeqCst)
        {
            return None;
        }
        let guard = session.master.lock().unwrap();
        let plain: &dyn MasterPty = &**guard;
        let id = plain.downcast_ref::<HostMaster>().map(HostMaster::id);
        id
    }

    impl PtyManager {
        /// Whether a native window holds terminal `id` right now.
        pub(crate) fn is_handed(&self, id: u32) -> bool {
            self.handed.lock().unwrap().contains_key(&id)
        }

        /// The terminals that could be handed over right now, by pty id.
        pub(crate) fn handover_candidates(&self) -> Vec<u32> {
            let proxies = self.proxy_ids();
            // Copied out first: asking a session for its master takes that
            // session's lock, which is not done while the map's is held.
            let all: Vec<Arc<Session>> = self.sessions.lock().unwrap().values().cloned().collect();
            let mut ids: Vec<u32> = all
                .iter()
                .filter(|s| !proxies.contains(&s.id) && hosted_id(s).is_some())
                .map(|s| s.id)
                .collect();
            ids.sort_unstable();
            ids
        }

        /// Step 1: let go of terminal `id`, leaving it running in the host with
        /// nobody attached. See the module doc for what is kept and why.
        pub(crate) fn release_to_native(&self, id: u32) -> Result<Handed, String> {
            if self.is_proxy(id) {
                return Err(NOT_HOSTED.into());
            }
            let session = self
                .get(id)
                .ok_or_else(|| format!("no terminal {id} to hand over"))?;
            let host_id = hosted_id(&session).ok_or(NOT_HOSTED)?;
            let handed = Handed {
                host_id,
                pid: session.pid.ok_or(NOT_HOSTED)?,
                session_generation: session.session_generation,
                kind: session.kind,
                execution_context: session.execution_context.clone(),
                command: session.command.clone(),
                name: session.name.lock().unwrap().clone(),
                title: session.title.lock().unwrap().clone(),
                cwd: session.cwd.clone(),
            };
            {
                let mut table = self.handed.lock().unwrap();
                if table.contains_key(&id) {
                    return Err(format!("terminal {id} is already in a native window"));
                }
                // Before the connection goes: from here a stale close of the
                // tab that showed it is refused instead of killing it.
                table.insert(id, handed.clone());
            }
            // `shutdown` as well as `handed_over`: a reader held back by a slow
            // page would otherwise not get as far as seeing the connection end.
            session.handed_over.store(true, Ordering::SeqCst);
            session.shutdown.store(true, Ordering::SeqCst);
            {
                let guard = session.master.lock().unwrap();
                let plain: &dyn MasterPty = &**guard;
                if let Some(hosted) = plain.downcast_ref::<HostMaster>() {
                    hosted.detach();
                }
            }
            // The flusher takes the session out of the map once its output has
            // ended. Waited for briefly so the window is not started while this
            // app still looks attached; a take back is correct even if it ran
            // late, because the flusher removes only its own session.
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while std::time::Instant::now() < deadline
                && self
                    .sessions
                    .lock()
                    .unwrap()
                    .get(&id)
                    .is_some_and(|s| Arc::ptr_eq(s, &session))
            {
                thread::sleep(Duration::from_millis(10));
            }
            Ok(handed)
        }

        /// Step 3, and the user's "Take back": attach to the host session again
        /// as this app's own terminal `id`, replacing whoever holds it (the
        /// window, which then sees its connection end). Refused when the host
        /// no longer has the same session running.
        pub(crate) fn take_back_with<R: tauri::Runtime>(
            &self,
            app: AppHandle<R>,
            client: &Client,
            id: u32,
        ) -> Result<(), String> {
            let handed = self
                .handed
                .lock()
                .unwrap()
                .get(&id)
                .cloned()
                .ok_or_else(|| format!("terminal {id} is not in a native window"))?;
            let listed = client
                .list_within(Duration::from_secs(2))
                .map_err(|e| format!("could not ask the terminal host: {e}"))?;
            let info = listed
                .into_iter()
                .find(|s| s.id == handed.host_id && s.pid == Some(handed.pid) && s.exited.is_none())
                .ok_or("The terminal has ended, so there is nothing to take back.")?;
            let found = Adoptable {
                info,
                meta: HostedMeta {
                    v: 1,
                    id,
                    generation: handed.session_generation,
                    ..Default::default()
                },
            };
            let taken = crate::pty_hosted::adopt_with(client, &found, true)?;
            let (reader, writer) = taken
                .master
                .try_clone_reader()
                .and_then(|r| taken.master.take_writer().map(|w| (r, w)))
                .map_err(|e| e.to_string())?;
            let parts = SessionParts {
                id,
                session_generation: handed.session_generation,
                pid: Some(taken.pid),
                kind: handed.kind,
                execution_context: handed.execution_context.clone(),
                recovered_run: false,
                recovered_command: handed.command.clone(),
                run_command_id: None,
                shell: handed.title.clone(),
                cwd: handed.cwd.clone(),
                child: taken.child,
                master_box: taken.master,
                reader,
                writer,
                desktop: None,
                high_water: None,
                cols: taken.cols,
                rows: taken.rows,
                history: taken.history,
                history_start: taken.history_start,
                survives_quit: true,
            };
            self.start_session(app, parts)?;
            if let Some(session) = self.get(id) {
                *session.name.lock().unwrap() = handed.name.clone();
                // Off this thread: it sleeps between the two sizes.
                thread::spawn(move || session.nudge_redraw());
            }
            self.handed.lock().unwrap().remove(&id);
            Ok(())
        }

        /// The whole hand-over: release, then `launch` the window, and if that
        /// fails take the terminal straight back, so a failed hand-over leaves it
        /// where it was.
        pub(crate) fn hand_over_with<R: tauri::Runtime>(
            &self,
            app: AppHandle<R>,
            client: &Client,
            id: u32,
            launch: impl FnOnce(&Handed) -> Result<(), String>,
        ) -> Result<(), String> {
            let handed = self.release_to_native(id)?;
            match launch(&handed) {
                Ok(()) => Ok(()),
                Err(error) => match self.take_back_with(app, client, id) {
                    Ok(()) => Err(error),
                    Err(back) => Err(format!("{error} (and it could not be taken back: {back})")),
                },
            }
        }

        /// Where every handed-over terminal is, asked of the host once. With no
        /// client (no host to ask) each is `Unreachable`.
        pub(crate) fn handover_status(&self, client: Option<&Client>) -> Vec<HandedStatus> {
            let mut handed: Vec<(u32, Handed)> = self
                .handed
                .lock()
                .unwrap()
                .iter()
                .map(|(id, h)| (*id, h.clone()))
                .collect();
            if handed.is_empty() {
                return Vec::new();
            }
            handed.sort_by_key(|(id, _)| *id);
            let listed = match client {
                Some(client) => client.list_within(Duration::from_secs(2)),
                None => Err(std::io::Error::other("no terminal host")),
            };
            handed
                .iter()
                .map(|(id, h)| HandedStatus {
                    pty_id: *id,
                    state: state_of(h, &listed),
                })
                .collect()
        }
    }
}

impl PtyManager {
    /// The tab that showed terminal `id` is gone: this app lets go of it
    /// without stopping it, and the window carries on. Returns whether it was
    /// held. The terminal stays in the host with its linger clock, and a later
    /// launch can adopt it once the window lets go.
    pub(crate) fn forget_handed(&self, id: u32) -> bool {
        self.handed.lock().unwrap().remove(&id).is_some()
    }
}

/// What the tab strip needs to draw this: which terminals can be handed over,
/// and where the handed-over ones are.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HandoverStatus {
    pub candidates: Vec<u32>,
    pub handed: Vec<HandedStatus>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use canopy_pty_host::protocol::SessionInfo;

    fn handed(host_id: u32, pid: u32) -> Handed {
        Handed {
            host_id,
            pid,
            session_generation: 1,
            kind: SessionKind::Desktop,
            execution_context: None,
            command: None,
            name: "n".into(),
            title: "t".into(),
            cwd: "/".into(),
        }
    }

    #[cfg(unix)]
    fn listed(sessions: Vec<SessionInfo>) -> std::io::Result<Vec<SessionInfo>> {
        Ok(sessions)
    }

    #[cfg(unix)]
    fn info(id: u32, pid: u32, attached: Option<bool>, exited: Option<i32>) -> SessionInfo {
        SessionInfo {
            id,
            pid: Some(pid),
            attached,
            exited,
            ..Default::default()
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_host_s_answer_says_where_a_handed_over_terminal_is() {
        let h = handed(4, 400);
        let state = |l: &std::io::Result<Vec<SessionInfo>>| state_of(&h, l);
        assert_eq!(
            state(&listed(vec![info(4, 400, Some(true), None)])),
            HandoverState::InWindow
        );
        assert_eq!(
            state(&listed(vec![info(4, 400, Some(false), None)])),
            HandoverState::Detached
        );
        // A host that predates the field cannot say: still the window's.
        assert_eq!(
            state(&listed(vec![info(4, 400, None, None)])),
            HandoverState::InWindow
        );
        assert_eq!(
            state(&listed(vec![info(4, 400, Some(false), Some(0))])),
            HandoverState::Ended
        );
        // Not listed, or listed under another pid (a restarted host numbers
        // sessions from 1 again): that is not this terminal.
        assert_eq!(state(&listed(vec![])), HandoverState::Ended);
        assert_eq!(
            state(&listed(vec![info(4, 999, Some(true), None)])),
            HandoverState::Ended
        );
        assert_eq!(
            state(&Err(std::io::Error::other("down"))),
            HandoverState::Unreachable
        );
    }

    #[test]
    fn a_stale_close_cannot_kill_a_terminal_a_window_holds_and_forgetting_lets_go() {
        let pm = PtyManager::default();
        pm.handed.lock().unwrap().insert(9, handed(1, 100));
        assert!(pm.is_handed_for_test(9));
        assert!(pm.kill(9).unwrap_err().contains("native window"));
        assert!(pm.forget_handed(9));
        assert!(!pm.forget_handed(9));
        // Not held any more, and not a session either.
        assert!(pm.kill(9).unwrap_err().contains("no pty session"));
    }

    impl PtyManager {
        fn is_handed_for_test(&self, id: u32) -> bool {
            self.handed.lock().unwrap().contains_key(&id)
        }
    }

    #[cfg(unix)]
    mod hosted {
        use super::*;
        use crate::pty_hosted::tests::{command, meta_for, InProcessHost};
        use canopy_pty_host::client::{HostClient, HostMaster};
        use std::io::{Read, Write};

        const INSTANCE: &str = "inst-h";

        /// A hosted terminal the manager holds under pty id 7 (spawned, left,
        /// and adopted, as a relaunch does), echoing each line it is sent.
        fn hosted_terminal(
            host: &InProcessHost,
        ) -> (PtyManager, tauri::App<tauri::test::MockRuntime>) {
            let (child, master) = crate::pty_hosted::spawn(
                &host.client,
                &command("echo before; while read x; do echo got-$x; done"),
                80,
                24,
                Some(meta_for(7, 3, "desktop", INSTANCE)),
            )
            .expect("hosted spawn");
            wait(|| host.client.list().unwrap()[0].end > 0);
            drop(master);
            drop(child);
            wait(|| host.client.list().unwrap()[0].attached == Some(false));
            let app = tauri::test::mock_app();
            let pm = PtyManager::default();
            assert_eq!(
                pm.adopt_from(app.handle().clone(), &host.client, INSTANCE),
                1
            );
            (pm, app)
        }

        fn wait(mut f: impl FnMut() -> bool) {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while std::time::Instant::now() < deadline && !f() {
                thread::sleep(Duration::from_millis(20));
            }
            assert!(f(), "timed out");
        }

        fn attached(host: &InProcessHost) -> Option<bool> {
            host.client.list().unwrap()[0].attached
        }

        fn screen(pm: &PtyManager, id: u32) -> String {
            pm.attach(id)
                .map(|(_, _, snap, _)| String::from_utf8_lossy(&snap).into_owned())
                .unwrap_or_default()
        }

        /// A window: an attach that replaces whoever holds the session, like
        /// `canopy-term-app --attach N --force`, with a reader pumped on a
        /// thread so a missing needle fails instead of hanging.
        struct Window {
            master: HostMaster,
            seen: std::sync::Arc<Mutex<Vec<u8>>>,
            ended: std::sync::Arc<AtomicBool>,
        }

        impl Window {
            fn open(client: &HostClient, host_id: u32) -> Window {
                let (master, _) = HostMaster::attach(client.clone(), host_id, 0).unwrap();
                let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
                let ended = std::sync::Arc::new(AtomicBool::new(false));
                let mut reader = master.try_clone_reader().unwrap();
                let (s, e) = (seen.clone(), ended.clone());
                thread::spawn(move || {
                    let mut buf = [0u8; 1024];
                    while let Ok(n) = reader.read(&mut buf) {
                        if n == 0 {
                            break;
                        }
                        s.lock().unwrap().extend_from_slice(&buf[..n]);
                    }
                    e.store(true, Ordering::SeqCst);
                });
                Window {
                    master,
                    seen,
                    ended,
                }
            }

            fn type_line(&self, line: &str) {
                let mut writer = self.master.take_writer().unwrap();
                writer.write_all(line.as_bytes()).unwrap();
            }

            fn shows(&self, needle: &str) -> bool {
                String::from_utf8_lossy(&self.seen.lock().unwrap()).contains(needle)
            }
        }

        fn launch_window<'a>(
            host: &InProcessHost,
            log: &'a Mutex<Vec<String>>,
            slot: &'a Mutex<Option<Window>>,
        ) -> impl FnOnce(&Handed) -> Result<(), String> + 'a {
            let client = host.client.clone();
            move |h: &Handed| {
                // The app let go before the window was started: with no window
                // yet, nobody else could have detached the session, so it
                // becomes unattached on its own.
                wait(|| client.list().unwrap()[0].attached == Some(false));
                log.lock().unwrap().push("launch after release".to_string());
                *slot.lock().unwrap() = Some(Window::open(&client, h.host_id));
                Ok(())
            }
        }

        #[test]
        fn hand_over_then_take_back_moves_the_one_client_in_order() {
            let host = InProcessHost::start("hov1");
            let (pm, app) = hosted_terminal(&host);
            assert_eq!(pm.handover_candidates(), vec![7]);
            assert_eq!(attached(&host), Some(true), "the app holds it");

            let log = Mutex::new(Vec::new());
            let slot = Mutex::new(None);
            pm.hand_over_with(
                app.handle().clone(),
                &host.client,
                7,
                launch_window(&host, &log, &slot),
            )
            .expect("hand over");
            // 1. Released before the window was launched.
            assert_eq!(*log.lock().unwrap(), vec!["launch after release"]);
            // 2. The window holds it; the app has no session and no way in.
            assert!(pm.get(7).is_none());
            assert!(pm.is_handed(7));
            assert!(pm.handover_candidates().is_empty());
            assert_eq!(
                pm.handover_status(Some(&host.client)),
                vec![HandedStatus {
                    pty_id: 7,
                    state: HandoverState::InWindow
                }]
            );
            assert!(pm.write(7, "from-the-ide\n").is_err());
            // A stale close is refused, and the terminal runs on.
            assert!(pm.kill(7).is_err());
            assert!(host.client.list().unwrap()[0].exited.is_none());
            // Handing over is not an exit: nothing was reported.
            assert!(pm.exits.lock().unwrap().is_empty());
            let window = slot.lock().unwrap().take().unwrap();
            wait(|| window.shows("before"));
            window.type_line("one\n");
            wait(|| window.shows("got-one"));

            // 3. Take back: the app holds it again, under the same id, with the
            // history the window saw, and the window's connection is ended.
            pm.take_back_with(app.handle().clone(), &host.client, 7)
                .expect("take back");
            wait(|| window.ended.load(Ordering::SeqCst));
            assert_eq!(attached(&host), Some(true));
            assert!(!pm.is_handed(7));
            assert!(pm.handover_status(Some(&host.client)).is_empty());
            let session = pm.get(7).expect("back under its own id");
            assert_eq!(session.session_generation, 3);
            wait(|| screen(&pm, 7).contains("got-one"));
            pm.write(7, "two\n").unwrap();
            wait(|| screen(&pm, 7).contains("got-two"));
            assert!(pm.exits.lock().unwrap().is_empty());
            let _ = host.client.kill(host.client.list().unwrap()[0].id);
        }

        #[test]
        fn a_launch_that_fails_takes_the_terminal_straight_back() {
            let host = InProcessHost::start("hov2");
            let (pm, app) = hosted_terminal(&host);
            let error = pm
                .hand_over_with(app.handle().clone(), &host.client, 7, |_| {
                    Err("no window".to_string())
                })
                .unwrap_err();
            assert_eq!(error, "no window");
            assert!(pm.get(7).is_some());
            assert!(!pm.is_handed(7));
            assert_eq!(attached(&host), Some(true));
            pm.write(7, "still\n").unwrap();
            wait(|| screen(&pm, 7).contains("got-still"));
            let _ = host.client.kill(host.client.list().unwrap()[0].id);
        }

        #[test]
        fn the_window_closing_after_a_take_back_does_not_detach_the_app() {
            let host = InProcessHost::start("hov3");
            let (pm, app) = hosted_terminal(&host);
            let (log, slot) = (Mutex::new(Vec::new()), Mutex::new(None));
            pm.hand_over_with(
                app.handle().clone(),
                &host.client,
                7,
                launch_window(&host, &log, &slot),
            )
            .unwrap();
            let window = slot.lock().unwrap().take().unwrap();
            pm.take_back_with(app.handle().clone(), &host.client, 7)
                .unwrap();
            wait(|| window.ended.load(Ordering::SeqCst));
            // The window's process now exits and drops its handles. That
            // connection was already replaced, so it must not release the
            // session out from under the app.
            drop(window);
            thread::sleep(Duration::from_millis(300));
            assert_eq!(attached(&host), Some(true));
            pm.write(7, "after\n").unwrap();
            wait(|| screen(&pm, 7).contains("got-after"));
            let _ = host.client.kill(host.client.list().unwrap()[0].id);
        }

        #[test]
        fn closing_the_tab_while_the_window_holds_it_leaves_the_window_running() {
            let host = InProcessHost::start("hov4");
            let (pm, app) = hosted_terminal(&host);
            let (log, slot) = (Mutex::new(Vec::new()), Mutex::new(None));
            pm.hand_over_with(
                app.handle().clone(),
                &host.client,
                7,
                launch_window(&host, &log, &slot),
            )
            .unwrap();
            let window = slot.lock().unwrap().take().unwrap();
            // The tab goes: forgotten, never killed.
            assert!(pm.forget_handed(7));
            assert!(pm
                .take_back_with(app.handle().clone(), &host.client, 7)
                .is_err());
            window.type_line("alive\n");
            wait(|| window.shows("got-alive"));
            assert!(host.client.list().unwrap()[0].exited.is_none());
            // The window closes: the session runs on in the host with its
            // linger clock, and is this app's to adopt again (a later launch,
            // or this one), not lost.
            drop(window);
            wait(|| attached(&host) == Some(false));
            assert!(host.client.list().unwrap()[0].exited.is_none());
            let found = crate::pty_hosted::adoptable(&host.client, INSTANCE);
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].meta.id, 7);
            let _ = host.client.kill(host.client.list().unwrap()[0].id);
        }

        #[test]
        fn a_window_that_closed_leaves_the_terminal_detached_and_it_can_be_taken_back() {
            let host = InProcessHost::start("hov5");
            let (pm, app) = hosted_terminal(&host);
            let (log, slot) = (Mutex::new(Vec::new()), Mutex::new(None));
            pm.hand_over_with(
                app.handle().clone(),
                &host.client,
                7,
                launch_window(&host, &log, &slot),
            )
            .unwrap();
            drop(slot.lock().unwrap().take());
            wait(|| attached(&host) == Some(false));
            assert_eq!(
                pm.handover_status(Some(&host.client)),
                vec![HandedStatus {
                    pty_id: 7,
                    state: HandoverState::Detached
                }]
            );
            pm.take_back_with(app.handle().clone(), &host.client, 7)
                .unwrap();
            assert_eq!(attached(&host), Some(true));
            wait(|| screen(&pm, 7).contains("before"));
            let _ = host.client.kill(host.client.list().unwrap()[0].id);
        }

        #[test]
        fn after_a_host_restart_the_terminal_is_ended_and_nothing_else_is_taken_back() {
            let first = InProcessHost::start("hov6a");
            let (pm, app) = hosted_terminal(&first);
            let (log, slot) = (Mutex::new(Vec::new()), Mutex::new(None));
            pm.hand_over_with(
                app.handle().clone(),
                &first.client,
                7,
                launch_window(&first, &log, &slot),
            )
            .unwrap();
            drop(slot.lock().unwrap().take());
            // The host restarts: a new one numbers its sessions from 1 again,
            // so a different terminal answers to the same host id.
            let second = InProcessHost::start("hov6b");
            let (decoy_child, decoy_master) = crate::pty_hosted::spawn(
                &second.client,
                &command("sleep 300"),
                80,
                24,
                Some(meta_for(1, 1, "desktop", "inst-other")),
            )
            .unwrap();
            let listed = second.client.list().unwrap();
            assert_eq!(listed[0].id, first.client.list().unwrap()[0].id);
            assert_ne!(
                listed[0].pid,
                pm.handed
                    .lock()
                    .unwrap()
                    .get(&7)
                    .map(|h| Some(h.pid))
                    .unwrap()
            );
            assert_eq!(
                pm.handover_status(Some(&second.client)),
                vec![HandedStatus {
                    pty_id: 7,
                    state: HandoverState::Ended
                }]
            );
            let error = pm
                .take_back_with(app.handle().clone(), &second.client, 7)
                .unwrap_err();
            assert!(error.contains("ended"), "{error}");
            // The other host's terminal was not touched, and the record stays
            // so the tab can say so until it is closed.
            assert!(pm.get(7).is_none() && pm.is_handed(7));
            assert_eq!(attached(&second), Some(true));
            drop((decoy_child, decoy_master));
            // A host that does not answer at all is not an ending.
            let nowhere = HostClient::new(std::env::temp_dir().join("canopy-handover-nobody.sock"));
            assert_eq!(
                pm.handover_status(Some(&nowhere)),
                vec![HandedStatus {
                    pty_id: 7,
                    state: HandoverState::Unreachable
                }]
            );
            assert!(pm
                .take_back_with(app.handle().clone(), &nowhere, 7)
                .is_err());
            assert!(pm.is_handed(7));
            let _ = first.client.kill(first.client.list().unwrap()[0].id);
            let _ = second.client.kill(second.client.list().unwrap()[0].id);
        }

        #[test]
        fn what_is_not_a_hosted_terminal_tab_cannot_be_handed_over() {
            let app = tauri::test::mock_app();
            let pm = PtyManager::default();
            // In-process in a test run: no child in the host.
            let id = pm
                .spawn_headless(app.handle().clone(), Some("/tmp".into()), None, None)
                .expect("spawn");
            assert!(pm.handover_candidates().is_empty());
            let error = pm.release_to_native(id).unwrap_err();
            assert_eq!(error, NOT_HOSTED);
            assert!(!pm.is_handed(id));
            assert!(pm.get(id).is_some(), "refused, so left alone");
            assert!(pm.release_to_native(9999).is_err());
            let _ = pm.kill(id);
        }
    }
}
