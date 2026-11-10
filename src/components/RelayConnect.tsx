// Remote desktop sharing from the Team panel.
//
// Signed in to a Canopy account, there is nothing to type: one button hosts the
// relay on the local network and offers it to the selected team as a card in
// team chat, where each teammate joins with one click (ChatCard, `relay-offer`).
// The name is the account's. Stopping posts an "ended" card in reply, and an
// offer that nobody ended still lapses (ChatCard.RELAY_OFFER_TTL_MS).
//
// Signed out, the same relay can still be hosted or joined by address and code,
// kept under "Advanced" so it is not the first thing a signed-in person meets.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getSettings, updateSettings } from "../settings";
import { peekTeamIdentity, subscribeTeamIdentity, teamIdentity, type TeamIdentity } from "../teamIdentity";
import { teamSession } from "../teamMessaging/session";
import { cardDraft, validRelayAddr, type Card } from "../teamMessaging/cardSchema";
import type { Notify, RelayHandle } from "../types";
import { selectedAccountTeam } from "./TeamHub";
import { Button } from "./ui";
import "./relayConnect.css";

const prettyCode = (code: string) => code.replace(/(\d{3})(\d+)/, "$1 $2");

/** The offer currently open in team chat, so Stop can end it even after the
 *  panel was closed and reopened. */
let activeOffer: { team: string; self: string; id: string } | null = null;

/** The address a teammate on this network would dial, if the relay has one a
 *  card may carry. */
export function offerAddress(ips: readonly string[], port: number | null): string | null {
  if (!port) return null;
  for (const ip of ips) if (validRelayAddr(`${ip}:${port}`)) return `${ip}:${port}`;
  return null;
}

async function accountTeam(): Promise<{ team: string; self: string } | null> {
  try {
    const dir = await invoke<{ teams?: { id: string }[]; selfId?: string }>("canopy_account_request", { route: "/api/teams", body: null });
    const teams = dir.teams ?? [];
    const picked = selectedAccountTeam();
    const team = teams.find((t) => t.id === picked)?.id ?? teams[0]?.id;
    return team && dir.selfId ? { team, self: dir.selfId } : null;
  } catch {
    return null;
  }
}

async function post(team: string, self: string, card: Card): Promise<string> {
  const draft = cardDraft(card);
  const sent = await teamSession(team, self).send(draft.text, null, [], draft.ext);
  return sent.id;
}

export function RelayConnect({ relay, onNotice }: { relay: RelayHandle; onNotice?: Notify }) {
  const s = relay.status;
  const [me, setMe] = useState<TeamIdentity | null | undefined>(() => peekTeamIdentity() ?? undefined);
  const [name, setName] = useState(() => getSettings().relayName);
  const [addr, setAddr] = useState(() => getSettings().relayAddr);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const offering = useRef(false);

  useEffect(() => {
    let live = true;
    void teamIdentity().then((id) => live && setMe(id));
    const off = subscribeTeamIdentity(() => live && setMe(peekTeamIdentity()));
    return () => {
      live = false;
      off();
    };
  }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      offering.current = false;
      onNotice?.(String(err), "error");
    } finally {
      setBusy(false);
    }
  };

  // Hosting started from the button: once the relay has a code and an address a
  // card may carry, offer it to the team. Once per hosting run.
  useEffect(() => {
    if (!offering.current || s.role !== "host" || !s.code) return;
    const address = offerAddress(s.ips, s.port);
    if (!address) return;
    offering.current = false;
    void (async () => {
      const target = await accountTeam();
      if (!target) return onNotice?.("Sharing on your network. Join a team to offer it to teammates.", "info");
      try {
        const id = await post(target.team, target.self, { type: "relay-offer", v: 1, addr: address, code: s.code! });
        activeOffer = { ...target, id };
        onNotice?.("Offered your desktop to the team.", "success");
      } catch (err) {
        onNotice?.(`Sharing, but the team offer was not posted: ${String(err)}`, "warn");
      }
    })();
  }, [s.role, s.code, s.ips, s.port, onNotice]);

  const stop = () =>
    run(async () => {
      const offer = activeOffer;
      activeOffer = null;
      if (offer) await post(offer.team, offer.self, { type: "relay-offer-ended", v: 1, request: offer.id }).catch(() => {});
      await relay.hostStop();
    });

  if (s.role === "host") {
    const lan = s.ips[0] && s.port ? `${s.ips[0]}:${s.port}` : null;
    return (
      <section className="desk-members" aria-label="Relay">
        <h3 className="team-hub-section">Remote desktop</h3>
        <div className="team-row">
          <span className="team-row-text">
            <strong>Sharing your desktop</strong>
            <span>
              {lan ?? `port ${s.port}`}
              {s.code ? ` · code ${prettyCode(s.code)}` : ""}
            </span>
          </span>
          <Button size="sm" variant="danger" disabled={busy} onClick={stop}>
            Stop
          </Button>
        </div>
      </section>
    );
  }

  if (s.role === "client") {
    return (
      <section className="desk-members" aria-label="Relay">
        <h3 className="team-hub-section">Remote desktop</h3>
        <div className="team-row">
          <span className="team-row-text">
            <strong>Connected to {s.addr}</strong>
            <span>as {s.name}</span>
          </span>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => run(() => relay.disconnect())}>
            Disconnect
          </Button>
        </div>
      </section>
    );
  }

  if (me === undefined) return null;

  if (me) {
    return (
      <section className="desk-members" aria-label="Relay">
        <h3 className="team-hub-section">Remote desktop</h3>
        <div className="team-row">
          <span className="team-row-text">
            <span>Let your team view or control your screen.</span>
          </span>
          <Button
            size="sm"
            variant="accent"
            disabled={busy}
            onClick={() =>
              run(async () => {
                offering.current = true;
                await relay.hostStart(me.name, "local");
              })
            }
          >
            {busy ? "Starting…" : "Share my desktop"}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="desk-members" aria-label="Relay">
      <h3 className="team-hub-section">Remote desktop</h3>
      <details className="relay-advanced">
        <summary>Advanced: host or join by address</summary>
        <div className="relay-form">
          <label className="relay-label" htmlFor="relay-name">Your name</label>
          <input id="relay-name" className="relay-input" placeholder="how teammates see you" value={name} onChange={(e) => setName(e.target.value)} />
          <Button
            variant="accent"
            disabled={busy || !name.trim()}
            onClick={() =>
              run(async () => {
                updateSettings({ relayName: name.trim() });
                await relay.hostStart(name.trim(), "local");
              })
            }
          >
            {busy ? "Starting…" : "Host a relay"}
          </Button>
          <div className="relay-sep">or join one</div>
          <label className="relay-label" htmlFor="relay-addr">Host address</label>
          <input id="relay-addr" className="relay-input" placeholder="192.168.1.20:6679" value={addr} onChange={(e) => setAddr(e.target.value)} />
          <label className="relay-label" htmlFor="relay-code">Code</label>
          <input
            id="relay-code"
            className="relay-input"
            placeholder="7-digit code"
            inputMode="numeric"
            maxLength={8}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <Button
            disabled={busy || !name.trim() || !addr.trim() || code.replace(/\D/g, "").length !== 7}
            onClick={() =>
              run(async () => {
                updateSettings({ relayName: name.trim(), relayAddr: addr.trim() });
                await relay.connect(addr.trim(), code.replace(/\D/g, ""), name.trim());
                setCode("");
              })
            }
          >
            {busy ? "Joining…" : "Join"}
          </Button>
        </div>
      </details>
    </section>
  );
}
