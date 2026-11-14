// The permissions step of first-run setup: everything the OS gates, each with
// the state the OS reports. A row says "Allowed" only when a check said so;
// one nobody can check (notifications) offers the settings page and claims
// nothing. Screen recording and Accessibility only take effect after a
// restart, so a row asked for and still off says that instead of going green.
import { useCallback, useEffect, useState } from "react";
import * as ipc from "../ipc";
import { getSettings } from "../settings";
import { currentPlatform } from "../shortcuts";
import { Button } from "./ui";

type Grant = "granted" | "denied" | "unasked" | "unknown";
type RowId = "full_disk" | "screen" | "input" | "microphone" | "notifications";

interface RowDef {
  id: RowId;
  icon: string;
  title: string;
  why: string;
  /** Label of the button that asks. */
  ask: string;
  open: () => Promise<void>;
}

const ROWS: RowDef[] = [
  {
    id: "full_disk",
    icon: "💽",
    title: "Full disk access",
    why: "Agents and terminals open Desktop, Documents and Downloads without a prompt each time.",
    ask: "Grant…",
    open: () => ipc.privacyOpenSettings("full_disk"),
  },
  {
    id: "screen",
    icon: "🖥",
    title: "Screen recording",
    why: "Agents take screenshots, and you can share your screen with your team.",
    ask: "Grant…",
    open: () => ipc.deskRequestPermission("screen"),
  },
  {
    id: "input",
    icon: "⌨",
    title: "Control this computer",
    why: "Agents click and type in apps, and a teammate you approve can take control.",
    ask: "Grant…",
    open: () => ipc.deskRequestPermission("input"),
  },
  {
    id: "microphone",
    icon: "🎙",
    title: "Microphone",
    why: "Dictate prompts. Speech is processed on this computer.",
    ask: "Open Settings",
    open: () => ipc.privacyOpenSettings("microphone"),
  },
  {
    id: "notifications",
    icon: "🔔",
    title: "Notifications",
    why: "Know when an agent finishes or needs you.",
    ask: "Open Settings",
    open: () => ipc.privacyOpenSettings("notifications"),
  },
];

/** The OS's answer for every row it can answer. Each source fails apart: one
 *  missing command must not blank the others. */
async function readGrants(): Promise<Partial<Record<RowId, Grant>>> {
  const [desk, privacy] = await Promise.all([
    ipc.deskPermissions().catch(() => null),
    ipc.privacyStatus().catch(() => null),
  ]);
  const out: Partial<Record<RowId, Grant>> = {};
  if (desk) {
    out.screen = desk.screen ? "granted" : "denied";
    out.input = desk.input ? "granted" : "denied";
  }
  if (privacy) {
    out.full_disk = privacy.full_disk;
    out.microphone = privacy.microphone;
  }
  return out;
}

function VoiceModelRow() {
  const [model, setModel] = useState<ipc.DictationModel | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const models = await ipc.dictationModels().catch(() => []);
    const chosen = getSettings().dictationModel;
    setModel(models.find((m) => m.id === chosen) ?? models.find((m) => m.is_default) ?? null);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const id = model?.id;
  useEffect(() => {
    if (!id) return;
    const sub = ipc
      .onDictationProgress((p) => {
      if (p.model !== id) return;
      if (p.phase === "error") {
        setProgress(null);
        setError(p.message ?? "Download failed");
      } else if (p.phase === "ready") {
        setProgress(null);
        void load();
      } else {
        setProgress(p.phase === "download" ? `${Math.floor(p.pct)}%` : "Finishing…");
      }
      })
      // No event bridge: the row still works, it just shows no percentage.
      .catch(() => null);
    return () => void sub.then((off) => off?.());
  }, [id, load]);

  // No dictation in this build: nothing to offer.
  if (!model) return null;
  const download = () => {
    setError(null);
    setProgress("0%");
    ipc.dictationDownload(model.id).catch((e) => {
      setProgress(null);
      setError(String(e));
    });
  };
  return (
    <li className="ob-perm">
      <span className="ob-perm-icon" aria-hidden>⬇</span>
      <span className="ob-perm-text">
        <strong>Voice model</strong>
        <small>
          {model.name}, {model.size_mb} MB, downloaded once.
          {error && <em role="alert"> {error}</em>}
        </small>
      </span>
      {model.downloaded ? (
        <span className="ob-state is-ok">Downloaded</span>
      ) : progress ? (
        <span className="ob-state" role="status">{progress}</span>
      ) : (
        <Button onClick={download} aria-label={`Download ${model.name}`}>Download</Button>
      )}
    </li>
  );
}

export function OnboardingPermissions() {
  const mac = currentPlatform() === "macos";
  const [grants, setGrants] = useState<Partial<Record<RowId, Grant>>>({});
  const [asked, setAsked] = useState<ReadonlySet<RowId>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mac) return;
    let live = true;
    const refresh = () => void readGrants().then((g) => live && setGrants(g));
    refresh();
    // The person grants in System Settings and comes back: re-read then.
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      live = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [mac]);

  const ask = (row: RowDef) => {
    setError(null);
    setAsked((prev) => new Set(prev).add(row.id));
    row.open().catch((e) => setError(String(e)));
  };

  return (
    <>
      <ul className="ob-perms" aria-label="Permissions">
        {mac &&
          ROWS.map((row) => {
            const grant = grants[row.id] ?? "unknown";
            return (
              <li className="ob-perm" key={row.id} data-grant={grant}>
                <span className="ob-perm-icon" aria-hidden>{row.icon}</span>
                <span className="ob-perm-text">
                  <strong>{row.title}</strong>
                  <small>
                    {row.why}
                    {asked.has(row.id) && grant !== "granted" && row.id !== "notifications" && (
                      <em> Allowed it? Restart Canopy.</em>
                    )}
                  </small>
                </span>
                {grant === "granted" ? (
                  <span className="ob-state is-ok">Allowed</span>
                ) : grant === "unasked" ? (
                  <span className="ob-state">Asked on first use</span>
                ) : (
                  <Button onClick={() => ask(row)} aria-label={`${row.ask.replace("…", "")}: ${row.title}`}>
                    {row.ask}
                  </Button>
                )}
              </li>
            );
          })}
        <VoiceModelRow />
      </ul>
      {error && <p className="ob-hint" role="alert">{error}</p>}
      <p className="ob-hint">
        {mac
          ? "Each is optional. Grant… opens the right page of System Settings."
          : "This computer asks for nothing up front."}
      </p>
    </>
  );
}
