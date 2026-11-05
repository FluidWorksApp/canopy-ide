# Workspace preview forwarding

A preview of an app running in a workspace renders in the desktop's embedded browser. Only the app's server stays in the workspace. There is no pixel or frame streaming.

`src-tauri/src/workspace_forward.rs` opens a loopback listener on the desktop for each forwarded port and carries each connection as one stream over a single WebSocket per workspace. The gateway relays that socket to `packages/remote-host/port-forward.mjs`, which dials the workspace's loopback. The preview proxy (`preview.rs`) then treats the forwarded port as any other server, so local and workspace previews share one rendering and recovery path.

## Trust boundary

Code served by a workspace runs in this computer's webview. That is a change from the earlier design, where website HTML never reached the desktop, and it was chosen deliberately. These limits apply:

- The tunnel needs `drive` permission. Tickets are one-use, and the gateway rechecks membership and revocation on the open stream. Read-only members cannot open it.
- The runtime refuses its own service ports (8080, 8081, 8787).
- Forwarded listeners bind `127.0.0.1` only. Other processes on the same computer can reach them while they are open.
- The page has no Tauri permissions, as with any proxied page.
- Pages from a forwarded server get a Content-Security-Policy that blocks plain `http:` requests, so they cannot address services on this computer. The exceptions are the proxy itself and forwarded ports that kept their number. A port that had to move is not addressable by number, so a page can never reach an unrelated local service using it.

The policy replaces any CSP the app sent, because the proxy already strips those. It also blocks plain `http:` assets from public hosts.

## Reliability

The desktop sends an end-to-end ping every 15 seconds, answered by the workspace rather than the gateway, and redials after 45 seconds of silence or at once after a sleep. Requests made during a reconnect wait up to 10 seconds for the tunnel. Per-stream send credit keeps the tunnel under the gateway's 1 MiB and 4 MiB buffer limits, so a large response slows itself rather than closing the shared connection. While a server is down or starting, the proxy serves a page that retries until it answers.

## Known limits

- A page on the proxy's origin calling another forwarded port is cross-origin, so that server's CORS rules must allow it. This matches local previews.
- `wss://` upstreams are not tunnelled by the proxy.
- The phone and web portal have no preview, because they have no local proxy.
