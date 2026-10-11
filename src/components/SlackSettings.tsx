import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./ui";
import * as ipc from "../ipc";
import { slackStatusChanged } from "../slackLive";
import { SlackWorkspaceCompanion } from "./SlackWorkspaceCompanion";

/** The companion in Slack, through Canopy's one Slack app (the hub on
 *  canopyide.dev). Adding it to a Slack workspace and linking a Slack identity
 *  both happen in the browser, started from this signed-in Canopy, so the hub
 *  knows the identity is really this account's. No token ever reaches here. */
export function SlackSettings({ companion }: { companion: string }) {
  const [status, setStatus] = useState<ipc.SlackHubStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const linkedCount = useRef(0);
  const refresh = useCallback(() => {
    void ipc
      .slackHub<ipc.SlackHubStatus>("status")
      .then((next) => {
        // A link finished in the browser: start answering without waiting
        // for the poller's next idle check.
        if (next.linked.length !== linkedCount.current) slackStatusChanged();
        linkedCount.current = next.linked.length;
        setStatus(next);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }, []);
  useEffect(() => {
    refresh();
    // The browser round-trip finishes outside this window; look again when
    // the user comes back to it.
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  const open = async (action: "install-url" | "link-url") => {
    setBusy(true);
    try {
      const { url } = await ipc.slackHub<{ url: string }>(action);
      if (!/^https:\/\/(canopyide\.dev|slack\.com)\//.test(url)) throw new Error("Canopy returned an unexpected link");
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };
  const unlink = async () => {
    setBusy(true);
    try {
      await ipc.slackHub("unlink");
      slackStatusChanged();
      refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const linked = status?.linked ?? [];
  const installs = status?.installs ?? [];
  const teams = (list: { teamName: string }[]) => list.map((t) => t.teamName).join(", ");
  const ready = Boolean(status?.configured);
  const isLinked = ready && linked.length > 0;
  // `installs` is only the workspaces this user installed; Canopy may well be
  // in a teammate's workspace, so "Link my Slack" is always on offer.
  const installedNotLinked = ready && !isLinked && installs.length > 0;

  const statusLine = !status
    ? "Checking…"
    : !status.configured
      ? "Slack is not available yet."
      : isLinked
        ? `Linked in ${teams(linked)}. DM or mention ${companion} there.`
        : installedNotLinked
          ? `Canopy is in ${teams(installs)}, but your Slack isn't linked.`
          : "Not linked.";

  const add = (label: string, accent: boolean) => (
    <Button
      variant={accent ? "accent" : "default"}
      onClick={() => void open("install-url")}
      disabled={busy}
      title="Add Canopy to a Slack workspace and link yourself"
    >
      {label}
    </Button>
  );
  const link = (accent: boolean) => (
    <Button
      variant={accent ? "accent" : "default"}
      onClick={() => void open("link-url")}
      disabled={busy}
      title="Canopy is already in your Slack workspace: link your Slack identity"
    >
      Link my Slack
    </Button>
  );


  return (
    <div className="set-item">
      <div className="set-item-head">
        <span className="set-item-name">Slack</span>
      </div>
      <div className="set-item-desc">
        Talk to {companion} from Slack while Canopy is signed in. Teammates you've given session access can
        mention you and {companion} together; only you can approve what it changes.
      </div>
      <div className="set-item-control">
        {(status || !error) && (
          <div className="set-item-desc" role="status">
            {statusLine}
          </div>
        )}
        {error && (
          <div className="set-item-desc set-error" role="alert">
            {error}
          </div>
        )}
        {ready && (
          <div className="set-item-control set-inline">
            {isLinked ? (
              <>
                {add("Add to another workspace", false)}
                <Button onClick={() => void unlink()} disabled={busy}>
                  Unlink
                </Button>
              </>
            ) : installedNotLinked ? (
              <>
                {link(true)}
                {add("Add to another workspace", false)}
              </>
            ) : (
              <>
                {add("Add to Slack", true)}
                {link(false)}
              </>
            )}
          </div>
        )}
        {ready && !isLinked && !installedNotLinked && (
          <div className="set-item-desc set-note">Already in a workspace with Canopy? Link my Slack instead.</div>
        )}
        {ready && <SlackWorkspaceCompanion current={status?.workspaceCompanion ?? null} onChange={refresh} />}
      </div>
    </div>
  );
}
