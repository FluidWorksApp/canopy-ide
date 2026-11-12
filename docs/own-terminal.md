# Canopy's own terminal

A native Rust terminal: its own window and renderer, usable with no IDE, with
networking built in. Claude, Codex and plain shells all run in it, any terminal
can talk to another machine, and the Canopy IDE becomes one client of it.

Decided with the owner on 2026-11-11. Sizes below are estimates for one engineer
working with an agent, not measurements.

## Layers

| Layer | Crate / PR | Build or adopt | Status |
|---|---|---|---|
| 1 Session host | `canopy-pty-host` (#780) | Built | Adoption and quit-survival under `CANOPY_PTY_HOST=1`; protocol 3; Windows host in progress |
| 2 Screen state | `canopy-term-core` screen (#784, #812) | Adopt libghostty-vt (Zig 0.15.2, Rust 1.90), own snapshot | libghostty-vt is the only engine; the alacritty_terminal `Screen` is removed. Build: `crates/canopy-term-core/README.md` |
| 3 CLI | `canopy-term-cli` (#783) | Build | `ls kill attach send capture wait new`; exclusive attach and `read_ring` next |
| 4 Remote protocol | not started | Build (ideas from mosh, tmux) | Snapshot on attach, per-device keys and pairing, per-client backpressure |
| 5 Network | `canopy-term-net` (#785, #789) | Build on iroh and the installed Tailscale | Local unix socket stays its own transport |
| 6 Service forwarding | not started | Build | Remote spawn (`--on <machine>`) and port forwarding |
| 7 Native window | `canopy-term-render` (#782), `canopy-term-input`, `canopy-term-window`, `canopy-term-session`, `canopy-term-app` | Build renderer, input, window, session and the app that joins them | wgpu, glyph atlas, shaping; kitty keyboard; IME; AccessKit; `canopy-term-app` opens a window on a host session (unix; never run on a real display yet) |

## Decisions

- **Staged.** The host, the screen engine with a snapshot, the CLI and the
  remote transport come first; the native window is built in parallel; Canopy
  moves onto the engine after.
- **Network: iroh and the installed Tailscale**, behind one `Transport` trait.
  Tailscale is driven through its own CLI (`status --json`, `whois`), with plain
  TCP to tailnet addresses: no Tailscale library in the build. Only read-only
  commands; Canopy never logs in for the user. Bundling Tailscale's official
  `tailscaled` with in-app login comes later. `tailscale-rs` (Tailscale's Rust
  client, marked experimental) compiled on all three OSes but is not used yet:
  156 packages and no MagicDNS or hostname lookup today.
- **Who may connect.** An allowlist, keyed on a stable identity: a device key
  (iroh) or a Tailscale stable node id plus user id (or tags for tagged nodes).
  Tailnet membership alone is not authorisation. "Allow" on a machine means it
  may connect in, and is off by default.
- **Hosted workspaces** join the tailnet: `tailscaled` in userspace mode inside
  the container (owned by the remote-workspace side). How a userspace node takes
  inbound connections is not yet verified.
- **Cloudflare** later, for public sharing only, by driving `cloudflared`.
- **Platforms:** macOS, Linux and Windows.
- **Quit.** Normal Quit detaches hosted terminals (two-hour linger, adopted on
  the next launch). "Quit and Stop All…" (⌥⌘Q, Ctrl+Shift+Q elsewhere) asks
  "Stop N running agents?" only when agents are running.
- **Licences.** cmux (GPL) and herdr (possibly AGPL) are read for ideas only.

## Rough size

| Layer | Estimate |
|---|---|
| Session host (adoption, quit-survival) | 2-3 weeks |
| Screen state | 1-2 weeks |
| CLI | 2-3 weeks |
| Remote protocol | 3-5 weeks |
| Network | 2-3 weeks, plus 2 for the second transport |
| Service forwarding | 2-3 weeks |
| Native window | 8-16 weeks |

A usable CLI and engine with remote attach, without the new window: roughly
10-14 weeks. Windows support adds 20-30%.

## Risks

- Network authorisation needs a security review before anything listens beyond
  the local socket.
- Adopted agents lose Canopy's tools until the context bridge has a stable
  address (in progress).
- The host binary must be packaged so an app update does not delete it while
  terminals are running (in progress).

## Needs a person to test

Quit and relaunch with live terminals; resize after adoption; CLI attach,
detach and terminal restore; window fonts, HiDPI, IME and VoiceOver/NVDA; two
real machines on a tailnet; the Windows host on a real machine; an app update on
a signed build while terminals run.
