# Streamed browsers and devices

Status: phase 1 (the workspace agent's streamed browser, with T3 Code's
control lock and profile lock) and phase 3 (devices through expo-device-hub)
are built as ports of T3 Code; see `packages/remote-host/session-control.mjs`,
`browser-contexts.mjs`, `browser-stream.mjs`, `src/remoteExecution/StreamedBrowser.tsx`,
`src-tauri/src/devicehub*.rs` and `src/devices/`. Phase 2 (local and SSH
browsers) is not built.

The goal is what T3 Code does: a browser tab, simulator or emulator runs on
one machine (the local computer, an SSH host or a cloud workspace), its screen
is streamed into a Canopy pane, the user's input goes back, and an agent can
drive the same page or device the user is watching.

This doc covers how T3 Code does it, what Canopy already has, and a phased
plan. The T3 Code references are to `pingdotgg/t3code` at `main`
(d5290e9, 2026-11-08, MIT licensed).

## How T3 Code does it

### Browser: Chromium screencast over a WebSocket

The server owns the browser page. That page is either its own Chromium,
launched with Playwright `launchPersistentContext`, or the desktop app's own
Electron webview, which the server adopts through a CDP relay
(`apps/desktop/src/preview/CdpRelay.ts`, `apps/server/src/preview/DesktopBrowserChannel.ts`).
Either way the server holds a CDP session on the page, and every client
(desktop, web, phone) is a viewer of it.

- **Transport.** One WebSocket per viewer at `/api/preview-stream/ws?threadId&tabId&quality&maxWidth&maxHeight`
  (`apps/server/src/preview/ServerBrowserStream.ts`). A WebSocket can't carry
  headers, so it authenticates with a cookie or a short-lived ticket in the
  query string.
- **Frames.** Each viewer gets its own CDP session and calls
  `Page.startScreencast` with JPEG at the viewer's quality (default 70) and its
  pane's size (`ServerBrowser.ts` `attachViewer`). Frames go out as binary
  messages.
- **Backpressure.** Only one frame is in flight per viewer. The viewer sends
  `{type:"ack"}` after painting, and only then does the server call
  `Page.screencastFrameAck`. Chromium stops producing frames after three
  unacked ones, so a slow viewer slows its own stream, not the page. Acks are
  paced at 100 ms, which caps a viewer near 30 fps.
- **Motion.** During bursts (4 frames in 300 ms) the screencast restarts at a
  smaller scale and quality 50. When it settles (200 ms), it sends one sharp
  still, because Chromium may drop the last frame of a burst.
- **Viewer queue.** Each viewer's queue holds 64 items and drops on overflow.
  A dropped frame is still acked to Chromium. State messages (`control`,
  `viewport`, `gone`) compact the backlog so a stalled viewer always gets the
  latest size and control state.
- **Input.** JSON messages in page CSS pixels (`mouse`, `wheel`, `key`,
  `text`, `viewport`, `takeControl`, `releaseControl`, `dialog`) become
  `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent` and
  `Input.insertText`. Keys and buttons a viewer pressed are released when it
  disconnects.
- **Control.** `SessionControl.ts` arbitrates between the agent and humans. A
  human "takes control", the agent's queued work drains first, and the agent's
  next operation fails with "Browser control changed. Refresh the snapshot",
  so it never clicks on a page that moved under it. Read-only operations
  (snapshot, console) still work while a human has control.
- **Visibility.** Only the visible tab streams. Screenshots and snapshots pause
  the screencast while they run.

### Devices: a supervised hub plus a driving CLI

`docs/internals/devices.md` in T3 Code describes this. Two npm tools are
installed at pinned versions and run as child processes:

- [expo-device-hub](https://github.com/expo/expo-device-hub) (MIT) streams. It
  vendors serve-sim (Apache-2.0) for iOS Simulator and serve-emu for Android.
  - iOS video is H.264 in AVCC envelopes over HTTP, decoded in the browser
    with WebCodecs. Input goes over a separate binary WebSocket.
  - Android multiplexes H.264 and JSON gestures over one WebSocket.
  - MJPEG is the fallback when WebCodecs is unavailable, and WebRTC is used
    where the hub insists on it.
- [agent-device](https://github.com/callstack/agent-device) (MIT) drives. The
  agent gets a few MCP tools (list, open, screenshot, close). `device_open`
  returns a launcher command bound to that device session, and the agent does
  everything else through that CLI.
- **Security.** The hub binds to loopback and is never exposed directly:
  serve-sim has an exec route whose token is readable from its own
  unauthenticated `/api`. A proxy allowlists the stream, config and screenshot
  routes and authenticates every request. Device settings go through typed
  RPCs that run `simctl` and `adb` server-side, never the hub's exec channel.
- **Remote hosts.** For SSH hosts, both endpoints are forwarded to the server's
  loopback, so the same proxy serves local and remote devices.

## What Canopy has today

| Piece | Where | What it does | What it lacks |
|---|---|---|---|
| Native browser | `src-tauri/src/browser.rs` | A real child WKWebView per tab | macOS only (`SUPPORTED`), local only, nothing to stream |
| Proxy preview | `src-tauri/src/preview.rs` | Loopback reverse proxy plus iframe; the engine for other platforms and remote workspaces | Shares one cookie jar; it isn't a real browser |
| Agent browser in a cloud workspace | `packages/remote-host/agent-browser.mjs` | Playwright over CDP on the workspace's Chromium, one headless page | **The user can't see it.** Agents drive a page nobody is watching |
| Workspace desktop | `RemoteDesktop.tsx`, `runner.mjs` | Xvfb plus x11vnc over noVNC, with input | A whole desktop at VNC quality, not a browser tab, and not the page the agent drives |
| Android | `src-tauri/src/android.rs`, `DeviceView.tsx` | `adb exec-out screencap` stills, pulled | Not video, local adb only |
| iOS | none | none | everything |
| Streams | `client.streamUrl`, `gateway.mjs:337` | One-use ticketed WebSockets with a stream allowlist | none; this is the transport to reuse |
| Port forward | `workspace_forward.rs`, `port-forward.mjs` | TCP over a multiplexed WebSocket with credit flow control | none |

The biggest gap is the third row. In a cloud workspace, the agent's
`canopy_browser_*` calls go to a headless Chromium that has no viewer.

## Plan

### Phase 1: watch and drive the workspace agent's browser

This closes the gap above with the parts that already exist.

1. **Host (`agent-browser.mjs`).** Add `attachViewer({quality,maxWidth,maxHeight,canOperate})`.
   It opens a second CDP session on the existing page
   (`page.context().newCDPSession(page)`), starts `Page.startScreencast`, and
   returns an async queue of frames and state. Use T3 Code's constants as a
   starting point: one frame in flight, ack after paint, a 64-item queue, and
   motion scaling.
2. **Runner and gateway.** Add a stream `/browser/stream` to `runner.mjs` and
   to the gateway's stream allowlist (`gateway.mjs:337`) and operations
   allowlists (`gateway.mjs:209`, `:237`). It uses the existing ticket flow
   (`client.streamUrl`).
3. **Wire format.**
   - Server to client, binary: a 16-byte header (`u32 seq`,
     `u16 cssWidth`, `u16 cssHeight`, `f32 pageScale`, `i16 offsetTop`,
     `u16 reserved`) followed by the JPEG bytes. The values come from
     `Page.screencastFrame.metadata`.
   - Server to client, text: JSON state, `{type:"control"|"viewport"|"navigated"|"dialog"|"gone"}`.
   - Client to server, text: JSON `{type:"ack",seq}` plus T3 Code's input
     messages in page CSS pixels.
4. **Control.** Port the `SessionControl` idea into `AgentBrowser`: a
   `controller` (agent, a viewer id, or none) and a `generation`. While a
   human holds control, mutating agent ops return 409 with "the user has
   control, take a new snapshot after they release it". `AgentBrowser.run`
   already serializes ops, so the agent's queue drains on handoff.
5. **Frontend.** Add a third preview engine, `"stream"`, to
   `src/previewEngine.ts`, used for remote workspaces instead of `"proxy"`.
   - The view is a `<canvas>` drawn with `createImageBitmap(blob)`. Pointer
     coordinates map to page pixels with the frame header.
   - Keyboard handling reuses the focus and release rules in
     `desktopInput.ts`. Add `releaseAll` on blur, hide and reconnect.
   - The browser toolbar (URL, back, reload, "Take control") talks to the
     runner's existing `POST /browser`.
   - `PreviewSubTab` stays the tab type. Agent ops keep going through
     `/ctx/browser`, so agent routing doesn't change.
6. **Visibility.** Stream only while the tab is visible, as `RemoteTerminal`
   and `RemoteDesktop` already gate on `document.hidden`.
   `AgentBrowserPip` can attach as a second viewer at low quality and a small
   `maxWidth`.

This gives the T3 Code experience for cloud workspaces: the user watches the
agent's page live, takes over to log in or click, and hands back.

### Phase 2: the same viewer for local and SSH browsers

- **Linux and Windows.** The native browser isn't available there today. Run a
  local Chromium (Chrome, Edge or Chromium found on the machine) headless, and
  drive it from Rust over CDP with `chromiumoxide` or raw CDP over
  `tokio-tungstenite`. Serve the same `/browser/stream` from the context bridge
  in `context.rs`. The phase 1 viewer then works unchanged, and agents get a
  real browser profile instead of the proxy.
- **macOS.** WKWebView has no CDP, so it can't be screencast the same way.
  Keep the native view for the person at the Mac. For phone and portal viewers,
  stream periodic `snapshot.rs` captures (the `AgentBrowserPip` loop already
  does this at 250 ms) over the same wire format. A
  Chromium-on-macOS engine is the alternative if full parity matters more
  than WebKit's shared cookies.
- **SSH hosts.** Run the phase 1 host code there and reach it through
  `workspace_forward.rs`'s tunnel, like T3 Code forwards its hub endpoints to
  loopback.

### Phase 3: streamed devices

- **Adopt expo-device-hub and agent-device.** Do it the way T3 Code does:
  pinned npm installs under `~/.canopy`, run as supervised child processes
  bound to loopback, behind an allowlisting proxy in `context.rs` that checks
  a ticket. Never proxy the hub's exec route.
  - This gives H.264 iOS Simulator and Android video, plus an agent CLI with
    semantic snapshots.
  - It replaces the `screencap` stills in `android.rs`. Keep `adb` and `simctl`
    for installs, logs and settings, run natively as typed actions.
- **Viewer.** `DeviceView.tsx` gains a WebCodecs decoder, with MJPEG as the
  fallback. The `DeviceSubTab` comment saying "deliberately not a video
  stream" goes away.
- **Cloud workspaces.** Devices stay on the user's computer. The relay in
  protocol §5.1 (`crates/canopy-service/src/device.rs`) already brings remote
  agents' device ops to the IDE, so only the agent's CLI calls need routing.
  The video never has to leave the machine.

## Decisions to make before building

1. **Engine on macOS.** Keep WKWebView plus snapshot streaming for remote
   viewers, or add a Chromium engine so local and remote behave the same?
2. **Device tools.** Take on expo-device-hub and agent-device as runtime
   dependencies (MIT, with serve-sim under Apache-2.0, so
   THIRD-PARTY-NOTICES.md needs updating), or write an adb and scrcpy path
   ourselves? The first is far less work and includes iOS. The second avoids
   Node on the user's machine.
3. **Who may operate.** Should a read-only workspace member be able to watch a
   stream? T3 Code separates read scope from operate scope. The gateway
   tickets would need the same split.
