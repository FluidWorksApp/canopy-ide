// Team relay side panel: host a relay (your Canopy IS the server, joined with a
// 7-digit code) or join a teammate's. Hosting is Local or Internet. Local is a
// direct TCP listener on the LAN. Internet rides the SAME shared endpoint as
// Canopy Remote — the app's server exposed through one tunnel (Cloudflare /
// ngrok / Tailscale) — so a teammate joins the tunnel URL over a WebSocket, no
// router setup. One endpoint, two credentials: the team code here is separate
// from the Remote PIN. Either way the channel is end-to-end encrypted (SPAKE2 +
// ChaCha20-Poly1305), so the tunnel provider only ever relays ciphertext.
import { useEffect, useState } from "react";
import * as ipc from "../ipc";
import type { RelayCommandMsg, RelayMember } from "../ipc";
import { getSettings, updateSettings } from "../settings";
import { trackerKey } from "../trackers";
import type { Notify, RelayHandle } from "../types";
import { LiveDot, PullRequestIcon, TeamIcon } from "./icons";

interface TeamPanelProps {
  relay: RelayHandle;
  onOpenChat: (peer: string | null, name: string) => void;
  onOpenInboxItem: (item: RelayCommandMsg) => void;
  onNotice: Notify;
}

/** "123 4567" — grouped the way people read codes to each other. */
const prettyCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/** Trust as a single glyph, not a word. A green tick is "this is who they were
 *  last time"; the one case that still needs words is "changed", because a name
 *  reappearing under a different identity key is exactly how a reused join code
 *  gets used to impersonate a teammate — that one must not be quiet. */
function TrustMark({ trust, keyHex }: { trust: string; keyHex: string | null }) {
  const fp = keyHex ? keyHex.slice(0, 8) : "";
  if (trust === "changed") {
    return (
      <span className="team-mark team-mark-changed" title={`Identity key CHANGED for this name — verify out-of-band before trusting. Key ${fp}…`}>
        ⚠
      </span>
    );
  }
  if (trust === "known") {
    return <span className="team-mark team-mark-ok" title={`Verified — same identity key as before (${fp}…)`}>✓</span>;
  }
  if (trust === "new") {
    return <span className="team-mark team-mark-new" title={`First time seeing this identity (${fp}…) — pinned now, verified on next join`}>✓</span>;
  }
  if (trust === "relayed") {
    return <span className="team-mark team-mark-relayed" title="Identity asserted by the host, not directly verified by you">✓</span>;
  }
  return null;
}

const ago = (ms: number) => {
  if (!ms) return "";
  const d = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  return `${Math.floor(d / 3600)}h ago`;
};

const prettySize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

/** Pick a file and offer it to a member — the transfer itself runs
 *  peer-to-peer; the outcome comes back as a relay:transfer event. */
export async function offerFileTo(memberId: string, memberName: string, onNotice: Notify) {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ title: `Send a file to ${memberName}` });
  if (typeof path !== "string") return;
  try {
    await ipc.relayOfferFile(memberId, path);
    onNotice(`Offered ${path.split("/").pop()} to ${memberName} — sends when they accept.`, "success");
  } catch (err) {
    onNotice(String(err), "error");
  }
}

export function TeamPanel({ relay, onOpenChat, onOpenInboxItem, onNotice }: TeamPanelProps) {
  const s = relay.status;
  const [name, setName] = useState(() => getSettings().relayName);
  const [addr, setAddr] = useState(() => getSettings().relayAddr);
  const [code, setCode] = useState("");
  const [visibility, setVisibility] = useState<"local" | "public">("local");
  const [busy, setBusy] = useState(false);
  // The shared public endpoint, mirrored from the global tunnel manager (the
  // very one Canopy Remote drives). When the internet path is chosen, this URL
  // — not a public IP — is what a teammate joins.
  const [tunnel, setTunnel] = useState<ipc.TunnelState>({
    running: false,
    provider: null,
    url: null,
    message: null,
  });
  useEffect(() => {
    void ipc.tunnelStatus().then(setTunnel).catch(() => {});
    const un = ipc.onTunnelState(setTunnel);
    return () => void un.then((f) => f());
  }, []);
  const tunnelUrl = tunnel.running && tunnel.url ? tunnel.url : null;

  /** Bring up the shared endpoint for an internet team: the app's server (so the
   *  /team/ws route is served) and a tunnel pointed at it (reused if Remote or a
   *  prior team already started one). The teammate then joins the tunnel URL. */
  const ensureInternetEndpoint = async () => {
    const st = await ipc.remoteEnable(); // idempotent — serves /team/ws + /remote
    const t = await ipc.tunnelStatus();
    if (!t.running) {
      const provider = getSettings().remoteTunnelProvider;
      const token = provider === "ngrok" ? trackerKey("ngrok") || undefined : undefined;
      setTunnel(await ipc.tunnelStart(provider, st.port, token));
    }
  };

  const run = (op: () => Promise<void>, after?: () => void) => {
    setBusy(true);
    op()
      .then(after)
      .catch((err) => onNotice(String(err), "error"))
      .finally(() => setBusy(false));
  };

  const copy = (text: string, what: string) =>
    void navigator.clipboard
      .writeText(text)
      .then(() => onNotice(`${what} copied.`, "success"))
      .catch(() => onNotice("Couldn't copy.", "error"));

  /** Accept a file offer: pick where to save, then pull it from the sender. */
  const acceptFile = async (item: RelayCommandMsg) => {
    const offer = item.payload as ipc.RelayFileOffer;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const dest = await save({ title: `Save ${offer.name}`, defaultPath: offer.name });
    if (!dest) return;
    try {
      await ipc.relayAcceptFile(offer, dest, item.from);
      relay.dismissInbox(item.id);
      onNotice(`Receiving ${offer.name}…`);
    } catch (err) {
      onNotice(String(err), "error");
    }
  };

  const others = s.members.filter((m) => m.id !== s.self_id);
  const totalUnread = Object.values(relay.unread).reduce((a, b) => a + b, 0);

  // A member row IS the chat entry: the person, whether they're verified (a
  // tick, nothing more), and how many messages are waiting. No File/Chat
  // buttons — the whole row opens the conversation, and files are sent from
  // inside it. File-sending lives with the message you're writing, not as a
  // sibling of the person's name.
  const memberRow = (m: RelayMember) => {
    const n = relay.unread[m.id] ?? 0;
    return (
      <div
        key={m.id}
        className="team-member"
        title={`Chat with ${m.name}`}
        onClick={() => onOpenChat(m.id, m.name)}
      >
        <LiveDot size={7} className="team-live" />
        <span className="team-member-name">{m.name}</span>
        {m.is_host && <span className="team-tag">host</span>}
        <TrustMark trust={m.trust} keyHex={m.key} />
        <span className="team-member-spacer" />
        {n > 0 && <span className="team-unread" title={`${n} unread`}>{n}</span>}
      </div>
    );
  };

  // Internet hosting shares the tunnel URL (the shared endpoint); local shares
  // the LAN address. The old public-IP path is gone.
  const localAddr = s.ips[0] && s.port ? `${s.ips[0]}:${s.port}` : null;
  const shareAddr = s.visibility === "public" ? tunnelUrl : localAddr;

  return (
    <div className="team-panel">
      <div className="side-panel-head">
        <span>Team</span>
      </div>

      {s.role === "off" && (
        <>
          <div className="team-intro">
            Chat, review requests and file drops between Canopys. One of you
            hosts — their Canopy is the relay, no server anywhere — and the
            rest join with the code.
          </div>
          <div className="team-form">
            <label className="team-label">Your name</label>
            <input
              className="team-input"
              placeholder="how teammates see you"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <label className="team-label">Reachable from</label>
            <div className="team-visibility">
              {(["local", "public"] as const).map((v) => (
                <button
                  key={v}
                  className={`team-vis-btn ${visibility === v ? "team-vis-active" : ""}`}
                  onClick={() => setVisibility(v)}
                >
                  {v === "local" ? "Local network" : "Internet"}
                </button>
              ))}
            </div>
            <div className="team-vis-hint">
              {visibility === "local"
                ? "Teammates on the same network (office, VPN) join via your LAN address. The channel is end-to-end encrypted either way."
                : "Teammates anywhere join via one public link — the same shared tunnel Canopy Remote uses (Cloudflare / ngrok / Tailscale), no router setup. The code bootstraps an end-to-end-encrypted channel (SPAKE2), so the tunnel only relays ciphertext."}
            </div>
            <button
              className="btn btn-accent team-cta"
              disabled={busy || !name.trim()}
              onClick={() =>
                run(async () => {
                  updateSettings({ relayName: name.trim() });
                  // Internet hosting rides the shared endpoint: make sure the
                  // server + tunnel are up before we register as host.
                  if (visibility === "public") await ensureInternetEndpoint();
                  await relay.hostStart(name.trim(), visibility);
                })
              }
            >
              {busy ? "Starting…" : "Host a relay"}
            </button>
            <div className="team-sep">or join one</div>
            <label className="team-label">Host address or link</label>
            <input
              className="team-input"
              placeholder="192.168.1.20 (LAN) or https://…trycloudflare.com"
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
            />
            <label className="team-label">Code</label>
            <input
              className="team-input team-code-input"
              placeholder="7-digit code"
              inputMode="numeric"
              maxLength={8}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button
              className="btn team-cta"
              disabled={
                busy || !name.trim() || !addr.trim() || code.replace(/\D/g, "").length !== 7
              }
              onClick={() =>
                run(async () => {
                  updateSettings({ relayName: name.trim(), relayAddr: addr.trim() });
                  await relay.connect(addr.trim(), code.replace(/\D/g, ""), name.trim());
                }, () => setCode(""))
              }
            >
              {busy ? "Joining…" : "Join"}
            </button>
          </div>
        </>
      )}

      {s.role === "host" && (
        <div className="team-hosting">
          <div className="team-status-line">
            <LiveDot size={8} className="team-live" />
            <span>
              Hosting — you are the relay
              {s.visibility === "public" ? " (internet)" : " (local network)"}
            </span>
          </div>
          {/* The two facts a teammate needs, each one click to hand over. */}
          <div
            className="team-code"
            title="Click to copy — teammates join with this code"
            onClick={() => s.code && copy(s.code, "Code")}
          >
            {s.code ? prettyCode(s.code) : ""}
          </div>
          <div className="team-addr-line">
            {s.visibility === "public" ? (
              tunnelUrl ? (
                <span className="team-addr" title="Your public link — click to copy" onClick={() => copy(tunnelUrl, "Link")}>
                  {tunnelUrl}
                </span>
              ) : (
                <span>{tunnel.message ?? "Bringing up the public link…"}</span>
              )
            ) : localAddr ? (
              <span className="team-addr" title="Your LAN address — click to copy" onClick={() => copy(localAddr, "Address")}>
                {localAddr}
              </span>
            ) : (
              <span>port {s.port} — no LAN address found</span>
            )}
          </div>
          <div className="team-host-actions">
            <button
              className="btn"
              disabled={busy}
              title="New code — members already connected stay; the old code stops admitting anyone new"
              onClick={() => run(() => relay.regenerateCode())}
            >
              New code
            </button>
            <button className="btn btn-danger" disabled={busy} onClick={() => run(() => relay.hostStop())}>
              Stop hosting
            </button>
          </div>
          <div className="team-note">
            End-to-end encrypted — the code performs a SPAKE2 key exchange, and
            every message and file is sealed with ChaCha20-Poly1305. Files are
            also integrity-checked on arrival.
          </div>
        </div>
      )}

      {s.role === "client" && (
        <div className="team-hosting">
          <div className="team-status-line">
            <LiveDot size={8} className="team-live" />
            <span>
              Connected to <strong>{s.addr}</strong> as {s.name}
            </span>
          </div>
          <div className="team-host-actions">
            <button className="btn btn-danger" disabled={busy} onClick={() => run(() => relay.disconnect())}>
              Disconnect
            </button>
          </div>
        </div>
      )}

      {s.role !== "off" && (
        <>
          <div className="team-section-head">
            Members <span className="badge">{s.members.length}</span>
            {totalUnread > 0 && (
              <span className="team-unread team-unread-total" title={`${totalUnread} unread`}>
                {totalUnread}
              </span>
            )}
          </div>
          <div
            className="team-member team-everyone"
            title="One channel the whole relay sees"
            onClick={() => onOpenChat(null, "Team chat")}
          >
            <TeamIcon size={13} />
            <span className="team-member-name">Everyone</span>
            <span className="team-member-spacer" />
            {(relay.unread[""] ?? 0) > 0 && (
              <span className="team-unread" title={`${relay.unread[""]} unread`}>
                {relay.unread[""]}
              </span>
            )}
          </div>
          {others.map(memberRow)}
          {others.length === 0 && (
            <div className="team-empty">
              Nobody else yet
              {s.role === "host" && s.code
                ? ` — share ${shareAddr ?? `port ${s.port}`} and code ${prettyCode(s.code)}.`
                : "."}
            </div>
          )}
        </>
      )}

      {relay.transfers.length > 0 && (
        <>
          <div className="team-section-head">Transfers</div>
          {relay.transfers.map((t) => {
            const pct = t.total > 0 ? Math.min(100, Math.round((t.done / t.total) * 100)) : 0;
            return (
              <div key={t.id} className={`team-transfer team-transfer-${t.status}`}>
                <div className="team-transfer-head">
                  <span className="team-transfer-dir">{t.direction === "in" ? "↓" : "↑"}</span>
                  <span className="team-transfer-name" title={t.name}>{t.name}</span>
                  <span className="team-transfer-pct">
                    {t.status === "ok" ? "done" : t.status === "failed" ? "failed" : `${pct}%`}
                  </span>
                </div>
                <div className="team-transfer-bar">
                  <div
                    className="team-transfer-fill"
                    style={{ width: `${t.status === "ok" ? 100 : pct}%` }}
                  />
                </div>
                <div className="team-transfer-sub">
                  {t.status === "failed"
                    ? t.detail
                    : `${prettySize(t.done)} / ${prettySize(t.total)}`}
                </div>
              </div>
            );
          })}
        </>
      )}

      {/* Project shares: a teammate is offering their whole project. Accepting
          opens a browsable tree; opening any file from it is what starts a live
          edit of that file. */}
      {relay.collab.projectOffers.size > 0 && (
        <>
          <div className="team-section-head">
            Live project <span className="badge badge-urgent">{relay.collab.projectOffers.size}</span>
          </div>
          {[...relay.collab.projectOffers].map(([doc, offer]) => (
            <div key={doc} className="team-inbox-item">
              <div className="team-inbox-head">
                <TeamIcon size={13} className="team-inbox-icon" />
                <span className="team-inbox-from">{offer.fromName}</span>
              </div>
              <div className="team-inbox-body">
                Wants to share their project <strong>{offer.name}</strong> with you — browse
                the files and open any of them to edit together, live.
              </div>
              <div className="team-inbox-actions">
                <button
                  className="btn-mini btn-accent"
                  onClick={() => {
                    relay.collab.acceptProject(doc);
                    onNotice(`Opening ${offer.name}…`);
                  }}
                >
                  Open
                </button>
                <button className="btn-mini" onClick={() => relay.collab.dismissProject(doc)}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {/* Live-edit invitations. Deliberately not folded into `inbox`: a collab
          offer resolves into an editor tab, not a command to act on once, and
          accepting one is the moment access is granted. */}
      {relay.collab.offers.size > 0 && (
        <>
          <div className="team-section-head">
            Live edit <span className="badge badge-urgent">{relay.collab.offers.size}</span>
          </div>
          {[...relay.collab.offers].map(([doc, offer]) => (
            <div key={doc} className="team-inbox-item">
              <div className="team-inbox-head">
                <TeamIcon size={13} className="team-inbox-icon" />
                <span className="team-inbox-from">{offer.fromName}</span>
              </div>
              <div className="team-inbox-body">
                Wants to edit <strong>{offer.name}</strong> with you, live. Your copy
                stays in memory — only they can save it.
              </div>
              <div className="team-inbox-actions">
                <button
                  className="btn-mini btn-accent"
                  onClick={() => {
                    relay.collab.accept(doc);
                    onNotice(`Opening ${offer.name}…`);
                  }}
                >
                  Join
                </button>
                <button className="btn-mini" onClick={() => relay.collab.dismiss(doc)}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {relay.inbox.length > 0 && (
        <>
          <div className="team-section-head">
            For you <span className="badge badge-urgent">{relay.inbox.length}</span>
          </div>
          {relay.inbox.map((item) => {
            const pr =
              item.kind === "open-pr"
                ? (item.payload as { pr?: { number?: number; title?: string } }).pr
                : undefined;
            const file =
              item.kind === "file-offer" ? (item.payload as ipc.RelayFileOffer) : undefined;
            const review =
              item.kind === "review"
                ? (item.payload as { title?: string; insertions?: number; deletions?: number })
                : undefined;
            return (
              <div key={item.id} className="team-inbox-item">
                <div className="team-inbox-head">
                  {item.kind === "open-pr" ? (
                    <PullRequestIcon size={13} className="team-inbox-icon" />
                  ) : (
                    <TeamIcon size={13} className="team-inbox-icon" />
                  )}
                  <span className="team-inbox-from">{item.from_name}</span>
                  <span className="team-member-age">{ago(item.ts)}</span>
                </div>
                <div className="team-inbox-body">
                  {pr
                    ? `Review PR #${pr.number}: ${pr.title}`
                    : review
                      ? `Review ${review.title} (+${review.insertions ?? 0} −${review.deletions ?? 0})`
                      : file
                        ? `Wants to send you ${file.name} (${prettySize(file.size)})`
                        : `${item.kind} — ${JSON.stringify(item.payload)}`}
                </div>
                <div className="team-inbox-actions">
                  {file ? (
                    <button className="btn-mini btn-accent" onClick={() => void acceptFile(item)}>
                      Save…
                    </button>
                  ) : (
                    <button className="btn-mini btn-accent" onClick={() => onOpenInboxItem(item)}>
                      {item.kind === "open-pr" ? "Open PR" : "Open"}
                    </button>
                  )}
                  <button className="btn-mini" onClick={() => relay.dismissInbox(item.id)}>
                    Dismiss
                  </button>
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
