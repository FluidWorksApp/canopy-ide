//! Workspace port forwarding: how an app running in a remote workspace reaches
//! this computer's embedded browser.
//!
//! A forwarded port is an ordinary listener on this machine's loopback, so the
//! preview proxy treats a workspace server exactly as it treats a local one.
//! Every connection to that listener becomes one numbered stream over a single
//! WebSocket per workspace, which `packages/remote-host/port-forward.mjs` dials
//! on the workspace's loopback. Only bytes cross; pages render here.
//!
//! Frames match the Canopy link's (`canopy_link::frame`), with the direction
//! reversed and two additions. WINDOW returns send credit, because the gateway
//! closes a tunnel that overruns its buffers, so one large response must slow
//! itself rather than cost every other stream the connection. PING is answered
//! by the workspace, not the gateway, so a live reply proves the whole path.
//!
//! The gateway takes one-use tickets and managed tokens rotate in the renderer,
//! so this side owns the connection and its retries but asks the renderer for a
//! fresh ticket before each attempt.

use crate::canopy_link::{backoff_capped, frame, parse, rand_unit};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch, Semaphore};
use tokio_tungstenite::tungstenite::Message;

const OPEN: u8 = 1;
const DATA: u8 = 2;
const END: u8 = 3;
const RESET: u8 = 4;
const WINDOW: u8 = 5;
const PING: u8 = 6;
const PONG: u8 = 7;
/// Must match MAX_STREAMS and RECEIVE_WINDOW in port-forward.mjs. Waiting for a
/// slot here means a burst queues instead of being reset by the workspace.
const MAX_STREAMS: usize = 24;
const SEND_WINDOW: usize = 32 * 1024;
const CHUNK: usize = 16 * 1024;
/// A browser request made during a reconnect waits this long for the tunnel.
const ATTACH_WAIT: Duration = Duration::from_secs(10);
const TICKET_WAIT: Duration = Duration::from_secs(15);
const CONNECT_WAIT: Duration = Duration::from_secs(15);
const CLOSE_GRACE: Duration = Duration::from_secs(30);
pub const TICKET_EVENT: &str = "workspace-forward:ticket";

#[derive(Clone, Copy)]
struct Timing {
    ping_every: Duration,
    dead_after: Duration,
    /// A connection must stay up this long before the retry backoff resets, so
    /// a link that connects and drops at once keeps backing off.
    stable_after: Duration,
    /// Longest wait between attempts, in seconds.
    max_backoff_secs: u64,
}
/// How long a probe waits for the workspace to answer before replacing the link.
const PROBE_WAIT: Duration = Duration::from_secs(3);
const TIMING: Timing = Timing {
    ping_every: Duration::from_secs(15),
    dead_after: Duration::from_secs(45),
    stable_after: Duration::from_secs(20),
    max_backoff_secs: 120,
};

enum Inbound {
    Data(Vec<u8>),
    End,
    Reset,
}
struct Stream {
    inbound: mpsc::UnboundedSender<Inbound>,
    credit: Arc<Semaphore>,
}
type Streams = Arc<Mutex<HashMap<u32, Stream>>>;

struct Session {
    out: mpsc::Sender<Message>,
    streams: Streams,
    next: AtomicU32,
    slots: Arc<Semaphore>,
    /// When anything last arrived from the workspace. A probe compares it with
    /// the moment it pinged.
    heard_at: Mutex<Instant>,
    /// Asks `run_session` to end so the reconnect loop replaces the connection.
    replace: tokio::sync::Notify,
}
type Live = watch::Sender<Option<Arc<Session>>>;

impl Session {
    async fn send(&self, kind: u8, id: u32, payload: &[u8]) -> bool {
        self.out
            .send(Message::Binary(frame(kind, id, payload)))
            .await
            .is_ok()
    }
}

fn dispatch(bytes: &[u8], streams: &Streams) {
    let Some((kind, id, payload)) = parse(bytes) else {
        return;
    };
    let mut streams = streams.lock().unwrap();
    match kind {
        DATA => {
            if let Some(stream) = streams.get(&id) {
                let _ = stream.inbound.send(Inbound::Data(payload.to_vec()));
            }
        }
        END => {
            if let Some(stream) = streams.get(&id) {
                let _ = stream.inbound.send(Inbound::End);
            }
        }
        RESET => {
            if let Some(stream) = streams.remove(&id) {
                let _ = stream.inbound.send(Inbound::Reset);
            }
        }
        WINDOW => {
            if let (Some(stream), Ok(bytes)) = (streams.get(&id), <[u8; 4]>::try_from(payload)) {
                stream
                    .credit
                    .add_permits(u32::from_be_bytes(bytes) as usize);
            }
        }
        _ => {}
    }
}

/// One local connection, carried as one stream until either end finishes.
async fn serve(socket: TcpStream, port: u16, mut live: watch::Receiver<Option<Arc<Session>>>) {
    let session = match tokio::time::timeout(ATTACH_WAIT, live.wait_for(Option::is_some)).await {
        Ok(Ok(session)) => session.clone().unwrap(),
        _ => return,
    };
    let Ok(_slot) = session.slots.clone().acquire_owned().await else {
        return;
    };
    let id = session.next.fetch_add(2, Ordering::Relaxed);
    let credit = Arc::new(Semaphore::new(SEND_WINDOW));
    let (inbound, mut from_workspace) = mpsc::unbounded_channel();
    session.streams.lock().unwrap().insert(
        id,
        Stream {
            inbound,
            credit: credit.clone(),
        },
    );
    let open = serde_json::json!({ "port": port }).to_string();
    if !session.send(OPEN, id, open.as_bytes()).await {
        session.streams.lock().unwrap().remove(&id);
        return;
    }
    let _ = socket.set_nodelay(true);
    let (mut read, mut write) = socket.into_split();

    let upload = {
        let session = session.clone();
        async move {
            let mut buffer = vec![0; CHUNK];
            loop {
                let count = read.read(&mut buffer).await.map_err(|_| ())?;
                if count == 0 {
                    return session.send(END, id, &[]).await.then_some(()).ok_or(());
                }
                let permits = credit.acquire_many(count as u32).await.map_err(|_| ())?;
                permits.forget();
                if !session.send(DATA, id, &buffer[..count]).await {
                    return Err(());
                }
            }
        }
    };
    let download = {
        let session = session.clone();
        async move {
            while let Some(message) = from_workspace.recv().await {
                match message {
                    Inbound::Data(bytes) => {
                        write.write_all(&bytes).await.map_err(|_| ())?;
                        let returned = (bytes.len() as u32).to_be_bytes();
                        if !session.send(WINDOW, id, &returned).await {
                            return Err(());
                        }
                    }
                    Inbound::End => {
                        let _ = write.shutdown().await;
                    }
                    Inbound::Reset => return Ok(()),
                }
            }
            Ok::<(), ()>(())
        }
    };
    tokio::pin!(upload, download);
    let closed_here = tokio::select! {
        finished = &mut download => finished.is_err(),
        finished = &mut upload => match finished {
            // The browser finished sending. Its response may still be arriving.
            Ok(()) => !matches!(tokio::time::timeout(CLOSE_GRACE, &mut download).await, Ok(Ok(()))),
            Err(()) => true,
        },
    };
    if session.streams.lock().unwrap().remove(&id).is_some() && closed_here {
        let _ = session.send(RESET, id, &[]).await;
    }
}

async fn listen(
    listener: TcpListener,
    port: u16,
    live: watch::Receiver<Option<Arc<Session>>>,
    mut stop: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            _ = stop.changed() => return,
            accepted = listener.accept() => {
                if let Ok((socket, _)) = accepted {
                    tokio::spawn(serve(socket, port, live.clone()));
                }
            }
        }
    }
}

/// Carries one connected socket until it is lost or `stop` fires.
async fn run_session<S>(
    socket: tokio_tungstenite::WebSocketStream<S>,
    live: &Live,
    stop: &mut watch::Receiver<bool>,
    timing: Timing,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, mut source) = socket.split();
    let (out, mut outgoing) = mpsc::channel::<Message>(256);
    let writer = tokio::spawn(async move {
        while let Some(message) = outgoing.recv().await {
            if sink.send(message).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    let streams: Streams = Default::default();
    let session = Arc::new(Session {
        out: out.clone(),
        streams: streams.clone(),
        next: AtomicU32::new(1),
        slots: Arc::new(Semaphore::new(MAX_STREAMS)),
        heard_at: Mutex::new(Instant::now()),
        replace: tokio::sync::Notify::new(),
    });
    live.send_replace(Some(session.clone()));
    let mut ping = tokio::time::interval(timing.ping_every);
    ping.tick().await;
    let mut heard = Instant::now();
    let mut ticked = SystemTime::now();
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            _ = session.replace.notified() => break,
            _ = ping.tick() => {
                // Monotonic time can stop while a laptop sleeps, and a socket
                // that slept through the network going away looks healthy.
                let slept = ticked.elapsed().unwrap_or_default() > timing.ping_every * 2;
                ticked = SystemTime::now();
                if slept || heard.elapsed() > timing.dead_after { break; }
                if out.send(Message::Binary(frame(PING, 0, &[]))).await.is_err() { break; }
            }
            message = source.next() => match message {
                Some(Ok(Message::Binary(bytes))) => {
                    heard = Instant::now();
                    *session.heard_at.lock().unwrap() = heard;
                    if bytes.first() != Some(&PONG) { dispatch(&bytes, &streams); }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            }
        }
    }
    live.send_replace(None);
    session.slots.close();
    streams.lock().unwrap().clear();
    drop(session);
    drop(out);
    writer.abort();
}

/// Ping the workspace now and replace the connection if nothing comes back
/// within `wait`. The routine ping notices a dead path after `dead_after`;
/// this is for the moments a path is likely to have died (the network changed,
/// the app came back to the front), where waiting that long leaves every
/// forwarded page hanging. Returns whether the connection was replaced.
async fn probe_session(session: Arc<Session>, wait: Duration) -> bool {
    let sent = Instant::now();
    if !session.send(PING, 0, &[]).await {
        session.replace.notify_one();
        return true;
    }
    tokio::time::sleep(wait).await;
    let heard = *session.heard_at.lock().unwrap();
    if heard < sent {
        session.replace.notify_one();
        true
    } else {
        false
    }
}

/// Connects, carries, and reconnects until stopped. `ask` requests a ticket,
/// which arrives on `tickets` as a WebSocket URL.
async fn maintain<A, F>(
    ask: A,
    mut tickets: mpsc::Receiver<String>,
    live: Live,
    mut stop: watch::Receiver<bool>,
    timing: Timing,
) where
    A: Fn() -> F,
    F: Future<Output = ()>,
{
    let mut attempt = 0;
    while !*stop.borrow() {
        while tickets.try_recv().is_ok() {}
        ask().await;
        let ticket = tokio::select! {
            _ = stop.changed() => return,
            ticket = tokio::time::timeout(TICKET_WAIT, tickets.recv()) => ticket,
        };
        let connected = match ticket {
            Ok(Some(url)) => {
                tokio::time::timeout(CONNECT_WAIT, tokio_tungstenite::connect_async(url)).await
            }
            Ok(None) => return,
            Err(elapsed) => Err(elapsed),
        };
        if let Ok(Ok((socket, _))) = connected {
            let up = Instant::now();
            run_session(socket, &live, &mut stop, timing).await;
            // Only a connection that lasted counts as recovered.
            if up.elapsed() >= timing.stable_after {
                attempt = 0;
            }
        }
        attempt += 1;
        tokio::select! {
            _ = stop.changed() => return,
            _ = tokio::time::sleep(backoff_capped(attempt - 1, rand_unit(), timing.max_backoff_secs)) => {}
        }
    }
}

struct Tunnel {
    tickets: mpsc::Sender<String>,
    stop: watch::Sender<bool>,
    live: watch::Receiver<Option<Arc<Session>>>,
    /// Workspace port to the local port serving it.
    ports: tokio::sync::Mutex<HashMap<u16, u16>>,
}

#[derive(Default)]
pub struct WorkspaceForwards(Mutex<HashMap<String, Arc<Tunnel>>>);

impl WorkspaceForwards {
    pub fn shutdown_all(&self) {
        for (_, tunnel) in self.0.lock().unwrap().drain() {
            let _ = tunnel.stop.send(true);
        }
    }
}

fn tunnel_for(app: &tauri::AppHandle, forwards: &WorkspaceForwards, key: &str) -> Arc<Tunnel> {
    let mut tunnels = forwards.0.lock().unwrap();
    if let Some(tunnel) = tunnels.get(key) {
        return tunnel.clone();
    }
    let (tickets, ticket_rx) = mpsc::channel(4);
    let (stop, stop_rx) = watch::channel(false);
    let (live, live_rx) = watch::channel(None);
    let tunnel = Arc::new(Tunnel {
        tickets,
        stop,
        live: live_rx,
        ports: Default::default(),
    });
    tunnels.insert(key.to_owned(), tunnel.clone());
    let (app, key) = (app.clone(), key.to_owned());
    tauri::async_runtime::spawn(async move {
        let ask = || {
            let _ = app.emit(TICKET_EVENT, serde_json::json!({ "key": key }));
            std::future::ready(())
        };
        maintain(ask, ticket_rx, live, stop_rx, TIMING).await;
    });
    tunnel
}

/// The workspace's own port number when it is free here, so a page's absolute
/// `localhost` links keep working, otherwise whichever port the system offers.
async fn bind(port: u16) -> Result<TcpListener, String> {
    match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => Ok(listener),
        Err(_) => TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| format!("Cannot forward workspace port {port}: {e}")),
    }
}

/// Forwards a workspace port to this machine and returns the local port.
#[tauri::command]
pub async fn workspace_forward_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceForwards>,
    key: String,
    port: u16,
) -> Result<u16, String> {
    let tunnel = tunnel_for(&app, &state, &key);
    let mut ports = tunnel.ports.lock().await;
    if let Some(local) = ports.get(&port) {
        return Ok(*local);
    }
    let listener = bind(port).await?;
    let local = listener.local_addr().map_err(|e| e.to_string())?.port();
    ports.insert(port, local);
    tokio::spawn(listen(
        listener,
        port,
        tunnel.live.clone(),
        tunnel.stop.subscribe(),
    ));
    Ok(local)
}

/// The renderer's answer to `TICKET_EVENT`.
#[tauri::command]
pub async fn workspace_forward_ticket(
    state: tauri::State<'_, WorkspaceForwards>,
    key: String,
    url: String,
) -> Result<(), String> {
    if !url.starts_with("wss://") && !url.starts_with("ws://") {
        return Err("Invalid workspace forward ticket".into());
    }
    let tunnel = state.0.lock().unwrap().get(&key).cloned();
    if let Some(tunnel) = tunnel {
        let _ = tunnel.tickets.send(url).await;
    }
    Ok(())
}

/// Check that the workspace still answers, and replace the connection if it
/// does not. The renderer calls it when the network returns or the window comes
/// back to the front.
#[tauri::command]
pub async fn workspace_forward_probe(
    state: tauri::State<'_, WorkspaceForwards>,
    key: String,
) -> Result<(), String> {
    let tunnel = state.0.lock().unwrap().get(&key).cloned();
    let session = tunnel.and_then(|t| t.live.borrow().clone());
    if let Some(session) = session {
        tokio::spawn(probe_session(session, PROBE_WAIT));
    }
    Ok(())
}

#[tauri::command]
pub fn workspace_forward_close(state: tauri::State<'_, WorkspaceForwards>, key: String) {
    if let Some(tunnel) = state.0.lock().unwrap().remove(&key) {
        let _ = tunnel.stop.send(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// A stand-in for port-forward.mjs: dials the requested port and relays.
    async fn workspace(listener: TcpListener, answer_pings: bool, accepted: Arc<AtomicUsize>) {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            accepted.fetch_add(1, Ordering::SeqCst);
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            tokio::spawn(async move {
                while let Some(Ok(message)) = ws.next().await {
                    let Message::Binary(bytes) = message else {
                        continue;
                    };
                    let (kind, id, payload) = parse(&bytes).unwrap();
                    let reply = match kind {
                        PING if answer_pings => frame(PONG, id, payload),
                        DATA => {
                            let mut upper = payload.to_ascii_uppercase();
                            upper.insert(0, b'>');
                            frame(DATA, id, &upper)
                        }
                        END => frame(RESET, id, &[]),
                        _ => continue,
                    };
                    if ws.send(Message::Binary(reply)).await.is_err() {
                        break;
                    }
                }
            });
        }
    }

    struct Harness {
        local: u16,
        accepted: Arc<AtomicUsize>,
        stop: watch::Sender<bool>,
        live: watch::Receiver<Option<Arc<Session>>>,
    }

    async fn harness(answer_pings: bool, timing: Timing) -> Harness {
        let remote = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("ws://{}", remote.local_addr().unwrap());
        let accepted = Arc::new(AtomicUsize::new(0));
        tokio::spawn(workspace(remote, answer_pings, accepted.clone()));
        let (tickets, ticket_rx) = mpsc::channel(4);
        let (stop, stop_rx) = watch::channel(false);
        let (live, live_rx) = watch::channel(None);
        let ask = move || {
            let (tickets, url) = (tickets.clone(), url.clone());
            async move {
                let _ = tickets.send(url).await;
            }
        };
        tokio::spawn(maintain(ask, ticket_rx, live, stop_rx, timing));
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let local = listener.local_addr().unwrap().port();
        let probe_live = live_rx.clone();
        tokio::spawn(listen(listener, 3000, live_rx, stop.subscribe()));
        Harness {
            local,
            accepted,
            stop,
            live: probe_live,
        }
    }

    /// Holds a real tunnel open for the end-to-end harness, which supplies the
    /// workspace and drives this listener. Not part of the normal test run.
    #[tokio::test]
    #[ignore = "needs FORWARD_E2E_URL, FORWARD_E2E_LOCAL and FORWARD_E2E_REMOTE"]
    async fn end_to_end_listener() {
        let url = std::env::var("FORWARD_E2E_URL").unwrap();
        let local: u16 = std::env::var("FORWARD_E2E_LOCAL").unwrap().parse().unwrap();
        let remote: u16 = std::env::var("FORWARD_E2E_REMOTE")
            .unwrap()
            .parse()
            .unwrap();
        let (tickets, ticket_rx) = mpsc::channel(4);
        let (stop, stop_rx) = watch::channel(false);
        let (live, live_rx) = watch::channel(None);
        let ask = move || {
            let (tickets, url) = (tickets.clone(), url.clone());
            async move {
                let _ = tickets.send(url).await;
            }
        };
        tokio::spawn(maintain(ask, ticket_rx, live, stop_rx, TIMING));
        let listener = TcpListener::bind(("127.0.0.1", local)).await.unwrap();
        tokio::spawn(listen(listener, remote, live_rx, stop.subscribe()));
        tokio::time::sleep(Duration::from_secs(120)).await;
    }

    #[tokio::test]
    async fn a_local_connection_reaches_the_workspace_and_back() {
        let h = harness(true, TIMING).await;
        let mut socket = TcpStream::connect(("127.0.0.1", h.local)).await.unwrap();
        socket.write_all(b"hello").await.unwrap();
        let mut reply = [0; 6];
        tokio::time::timeout(Duration::from_secs(5), socket.read_exact(&mut reply))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&reply, b">HELLO");
        let _ = h.stop.send(true);
    }

    async fn session_of(h: &Harness) -> Arc<Session> {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(s) = h.live.borrow().clone() {
                    return s;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("a session should come up")
    }

    #[tokio::test]
    async fn a_probe_replaces_a_silent_path_without_waiting_for_the_routine_check() {
        // The routine check would take a minute; the probe must not.
        let timing = Timing {
            ping_every: Duration::from_secs(60),
            dead_after: Duration::from_secs(180),
            stable_after: Duration::from_millis(100),
            max_backoff_secs: 30,
        };
        let h = harness(false, timing).await;
        let session = session_of(&h).await;
        assert!(probe_session(session, Duration::from_millis(200)).await);
        tokio::time::timeout(Duration::from_secs(8), async {
            while h.accepted.load(Ordering::SeqCst) < 2 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the silent path should be redialled");
        let _ = h.stop.send(true);
    }

    #[tokio::test]
    async fn a_probe_leaves_a_path_that_answers() {
        let h = harness(true, TIMING).await;
        let session = session_of(&h).await;
        assert!(!probe_session(session, Duration::from_millis(500)).await);
        assert_eq!(h.accepted.load(Ordering::SeqCst), 1);
        let _ = h.stop.send(true);
    }

    #[tokio::test]
    async fn a_workspace_that_stops_answering_is_replaced() {
        let timing = Timing {
            ping_every: Duration::from_millis(50),
            dead_after: Duration::from_millis(150),
            stable_after: Duration::from_millis(100),
            max_backoff_secs: 30,
        };
        let h = harness(false, timing).await;
        tokio::time::timeout(Duration::from_secs(8), async {
            while h.accepted.load(Ordering::SeqCst) < 2 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("a silent path should be redialled");
        let _ = h.stop.send(true);
    }

    #[test]
    fn send_credit_is_returned_to_the_right_stream() {
        let streams: Streams = Default::default();
        let (inbound, _keep) = mpsc::unbounded_channel();
        let credit = Arc::new(Semaphore::new(0));
        streams.lock().unwrap().insert(
            7,
            Stream {
                inbound,
                credit: credit.clone(),
            },
        );
        dispatch(&frame(WINDOW, 7, &100u32.to_be_bytes()), &streams);
        dispatch(&frame(WINDOW, 9, &100u32.to_be_bytes()), &streams);
        assert_eq!(credit.available_permits(), 100);
    }
}
