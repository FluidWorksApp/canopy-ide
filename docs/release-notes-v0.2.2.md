# Canopy v0.2.2

**Team Relay** — Canopy now connects to your teammates directly, so you can chat, review, share files, and edit code together, with no server in the middle.

## Team Relay: work together, peer-to-peer

- **Connect over the internet, not just your LAN.** One person hosts — their Canopy is the relay — and teammates join with a code. Local network is a direct TCP connection; over the internet it's a direct P2P link (STUN discovery + UDP hole-punch + a reliable QUIC stream), so it works across home routers with **no middleman and nothing to self-host**.
- **End-to-end encrypted.** The join code performs a SPAKE2 key exchange and every message and file is sealed with ChaCha20-Poly1305; files are integrity-checked on arrival. Each teammate has a pinned identity with a trust tick.
- **Chat & file drops.** Direct or everyone-channel chat between Canopies. Send a file straight from the chat composer — it shows up in the conversation, with transfer progress.
- **Code review over the relay.** "Request review" on a branch sends its diff to a teammate over the encrypted channel; they read it in a review tab.

## Live collaboration

- **Co-edit a file, live.** Share any open file with a teammate and edit it together in real time — remote cursors and selections included — using owner-sequenced operational transform. Only the owner can save.
- **Share a whole project.** Share your project and a teammate browses its file tree (the real file browser) and opens any file on demand to edit together.
- **Follow along.** When a teammate opens a file from your shared project, it opens and focuses in your editor too, so you can watch what they're working on.
- **Always-visible indicator.** A blinking **Collaborating** pill in the title bar shows when a session is live, from any tab — and its **✕** ends every share and session in one click.

## Team panel & notifications

- Member rows are just the person: name, a trust tick, and an unread count.
- Unread is counted per conversation, per identity.
- The Team rail icon shows the live connection state (green when connected) and pops a toast if the relay drops.
- Notifications sit in the bottom-right.

## Fixes

- **Relay joins now work on macOS.** The accepted socket inherited the listener's non-blocking flag on macOS/BSD, so every join failed with a silent timeout. Cleared the flag; a regression test guards it.
- Terminals surface their endpoints, and clicking a running session jumps to its tab.
- The right-hand rail dropdown now has the styles it was missing.

---

*Encrypted, peer-to-peer, local-first — your code and conversations don't pass through anyone else's servers.*
