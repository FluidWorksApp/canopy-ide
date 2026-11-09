# Remote desktop

Canopy can show you a connected teammate's screen and, if they allow it, let you
drive their mouse and keyboard. It is built on the existing team relay, and
nothing is shared until the person at that computer says yes.

## How to use it

1. Both of you join the same team relay (host or connect from the Team panel).
2. In the Team panel, open **Remote desktop** and choose **View** or
   **Control** next to a teammate. The row shows while the request is being sent
   and reports a delivery error without creating a duplicate request.
3. They see a dialog with the requested access, the available device trust
   verdict and a short key fingerprint: **Accept view-only**, **Accept control**
   when control was requested, or **Deny**. Closing the dialog or pressing Esc
   denies. Relay-hosted identity metadata is labeled as host-asserted, and names
   remain self-chosen.
4. While the session is live, they see a red banner across the top of the window
   ("Ada is viewing your screen" or "Ada is controlling your screen") with a
   **Stop** button. You see the remote screen with a View only or Control badge
   and an **End** button. Notifications record the request, the active grant and
   its end.

The grant is clamped to what was asked: a view-only request can never become
control.

## Design and research

### Why the relay and not WebRTC

WebRTC is the usual answer for screen sharing, and RustDesk, Chrome Remote
Desktop and most browser tools use some form of it. It was rejected here because
Canopy already ships what WebRTC would have to be bolted on to provide:

- an authenticated SPAKE2 key exchange and a ChaCha20-Poly1305 channel per peer,
- Ed25519 member identities with trust-on-first-use verdicts,
- membership, presence and a host that routes frames between members.

Adding WebRTC would mean a signalling path, STUN/TURN for NAT traversal, a second
crypto stack and a large native dependency, all to move an image a few times a
second. Frames are bounded JPEGs and input events are tiny, so the relay is
enough. The cost is that traffic goes through the host (or directly if you are
the host) rather than peer to peer, which limits frame rate and resolution.

### Comparison

| | AnyDesk / TeamViewer | RustDesk | Canopy |
| --- | --- | --- | --- |
| Transport | Proprietary, vendor relay | Own protocol, optional self-hosted relay | Existing encrypted team relay |
| Video | Hardware codecs, high fps | VP9/H.264, high fps | Downscaled JPEG, about 8 fps |
| Identity | Vendor account or numeric id | Numeric id and password | Relay membership and pinned Ed25519 key |
| Consent | Accept dialog or unattended password | Accept dialog or password | Accept dialog every session, no unattended mode |
| Extras | File transfer, clipboard, audio | Same | None by design |

Canopy trades quality for a small attack surface: it is meant for helping a
teammate with a problem, not for replacing a remote workstation.

## Consent model

- Capture and input injection start only from an explicit local accept for that
  session. The accept is a Tauri command (`desk_respond`) invoked from the dialog;
  there is no wire message that starts capture on its own.
- Each session has a viewer-minted token and a single allowed peer. Messages from
  anyone else are dropped.
- One session at a time. A second request while busy is refused.
- Input is honored only in control mode. In view-only mode the backend rejects
  input events, and the viewer UI does not send them either.
- The banner is persistent and cannot be dismissed, only stopped. Stopping,
  denying, either side pressing End, the peer leaving the relay, the relay
  stopping, or app exit all end the session and the capture thread.
- An unanswered request expires after 60 seconds on both viewer and target.
  Each side emits an ended state and tries to notify the peer. A timeout checks
  the exact session and requested phase, so it cannot end an accepted or newer
  session. A request is expired at the exact 60-second boundary.
- No clipboard sync, no file access, no audio. Text input is capped and refused
  if it contains control characters.
- The request also appears in Notifications so it is not missed if the window is
  in the background.

## Threat model

| Threat | Mitigation |
| --- | --- |
| A relay member spoofs another as viewer | The host re-stamps `from` from the authenticated link. Members cannot choose it. |
| A member broadcasts frames or input to others | `Frame::Desk` requires a single `to` and is never fanned out. |
| Flooding the target with frames or input | Each authenticated member has two independent Desk relay token buckets: 24 messages burst with 16 messages/s refill, plus 4 MiB serialized burst with 13 MiB/s refill. The normal 1600px, about 8 fps stream fits these bounds. Input also has a per-session limiter in the core. Other relay traffic does not consume the Desk budget. |
| Oversized or malformed frames | Validated before fan-out: frame cap 1.5 MiB base64, dimension cap, text cap, strict key allow list, normalized coordinates must be in 0..1. Unknown message kinds fail to parse and are dropped. |
| Replayed or stale frames | Frame `seq` must strictly increase. |
| Remote user types dangerous shortcuts | Keys outside the allow list are refused. Control is something the local user grants knowingly, and they can stop it instantly. |
| Forgotten session | Pending requests actively expire after 60 seconds on viewer and target. Sessions also end on disconnect, relay stop and app exit. |
| Sniffing by other members or the network | Each link is SPAKE2 plus ChaCha20-Poly1305. |
| The relay host | Encryption is per link, not end to end. The host decrypts and re-seals every message, so it can see the screen and can forge the sender. Only share with teams whose host you trust. |
| Name lookalikes or changed devices | Names are self-chosen. The consent dialog shows the available trust verdict and a short Ed25519 key fingerprint. A changed key is a warning. A relayed identity is explicitly host-asserted, not directly verified. |
| Stuck keys | Keys and buttons held on the target are released when a session ends, and the viewer releases them on blur. |

Not covered: a teammate you accept control for can do anything you can do at the
keyboard. Only grant control to people you trust, and prefer view-only.

## Limits

- **Linux machines cannot share their screen in this build.** The screen capture
  crate needs libpipewire on Linux, which the build images do not carry. A Linux
  target answers Accept with a clear "not available" denial. Linux users can
  still view and control Windows and macOS teammates.
- Native capture and input are behind the `desk-native` cargo feature, which is
  off by default. Without it, the whole protocol and consent flow still run but
  sharing reports as unavailable. Build with
  `cargo build --manifest-path src-tauri/Cargo.toml --features desk-native` to
  enable it (Windows and macOS capture, input injection via enigo).
- Primary display only, downscaled to at most 1600 px wide, about 8 fps and
  slower when sends back up.
- Pending requests end automatically after 60 seconds even if the target address
  became stale and the host silently dropped the original request.
- There is no OS-level indicator of live control. The red banner lives inside the
  Canopy window. Notifications record both the request and the active grant, but
  a minimized or hidden window cannot provide an always-visible system signal.
- CI compiles the application library with `desk-native` on Windows and macOS.
  This catches platform-specific xcap/enigo compile failures only. Native
  capture, permission prompts, frame delivery and input injection still require
  tests on physical machines before relying on them.

## OS permissions

- **macOS:** the sharing machine needs **Screen Recording** (to capture) and
  **Accessibility** (to inject input) for Canopy under System Settings, Privacy
  and Security. If one is missing the session ends with an error naming it
  instead of streaming a blank screen. macOS may require restarting Canopy after
  granting.
- **Wayland (Linux):** compositors do not let apps capture other windows or inject
  input without a portal, and this build does not implement sharing on Linux at
  all. X11 injection works through enigo when built with `desk-native`, but
  capture is still unavailable.
- **Windows:** no extra permission, but input cannot be injected into elevated
  windows unless Canopy is also elevated.

## Code map

- `crates/canopy-core/src/desk.rs`: wire types, validation, session state
  machine, rate limiter, frame pacer, `ScreenSource`/`InputSink` traits and fakes.
- `src-tauri/src/desk.rs`: Tauri commands `desk_request`, `desk_respond`,
  `desk_send_input`, `desk_end`, `desk_status`; events `desk:state`, `relay:desk`.
- `src-tauri/src/relay.rs`: `Frame::Desk` routing.
- `src/desk.ts`: framework-free viewer logic (pointer mapping, key allow list,
  throttle, session reducer).
- `src/components/RemoteDesktopView.tsx`: viewer, consent dialog, banner, Team
  panel action. State is owned once in `src/App.tsx` and exposed on `RelayHandle`.

## How to test

- Unit: `cargo test --locked --manifest-path crates/canopy-core/Cargo.toml desk`,
  `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features desk`,
  and `npx vitest run src/desk.test.ts src/components/RemoteDesktopView.test.tsx`.
- Manual (two machines, one Windows or macOS built with `desk-native`): connect
  both to a relay, request from the Team panel, check the consent dialog appears
  first, accept view-only and confirm clicking in the viewer does nothing, end,
  repeat with control, confirm the banner and Stop, then kill the viewer app and
  confirm the banner disappears.
