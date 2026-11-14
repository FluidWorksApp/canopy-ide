// "Connect your brain": the one step that makes Canopy intelligent.
//
// One component for every place the question is asked — the first-run
// walkthrough, Settings → Agents → Brain, the dialog the status-bar chip and
// every "Connect your brain" button open — so the four can never describe the
// same state four ways. It lists the installed CLIs that can be the brain,
// recommends one, checks it live, and turns each failure into its fix: install
// it, sign in to it (in a real terminal, re-checked when that terminal exits),
// or wait out a rate limit.
//
// Only the intelligent surfaces wait on this. Files, terminals and git work
// without a brain, so nothing here is modal to the IDE.

import { useEffect, useState } from "react";
import type { AcpPreset } from "../acp/providers";
import { useEscape } from "../useEscape";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { Button, Field, Row, Select, TextInput } from "./ui";
import {
  addAcpPreset,
  brainCandidates,
  brainCapableClis,
  brainStateText,
  chooseBrain,
  installableAcpPresets,
  initBrainConnect,
  OPEN_BRAIN_CONNECT_EVENT,
  openBrainConnect,
  recommendedBrain,
  signInSteps,
  startBrainInstall,
  startBrainSignIn,
  useBrainConnection,
} from "../brainConnect";
import { checkBrainConnection } from "../brainStatus";
import { installedBrain } from "../brain";
import {
  agentModelSwitchFor,
  checkDesktopClis,
  CLI_INSTALLS_CHANGED_EVENT,
  legacyRunnerFor,
  type AgentCli,
} from "../projects";
import { getSettings, updateSettings, type Settings } from "../settings";
import "./brainConnect.css";

/** What is installed, re-read when an install lands. Empty until the first
 *  answer, with `loaded` saying whether that emptiness is real. */
function useInstalled(): { installed: Record<string, boolean>; loaded: boolean } {
  const [state, setState] = useState<{ installed: Record<string, boolean>; loaded: boolean }>({
    installed: {},
    loaded: false,
  });
  useEffect(() => {
    let live = true;
    const pull = () =>
      void checkDesktopClis()
        .catch(() => ({}) as Record<string, boolean>)
        .then((installed) => {
          if (live) setState({ installed, loaded: true });
        });
    pull();
    window.addEventListener(CLI_INSTALLS_CHANGED_EVENT, pull);
    return () => {
      live = false;
      window.removeEventListener(CLI_INSTALLS_CHANGED_EVENT, pull);
    };
  }, []);
  return state;
}

/** Main and background model for the brain. Empty means the CLI's own
 *  default (main) or the runner's cheap alias (background). */
export function BrainModels({ cli, before }: { cli: AgentCli; before?: React.ReactNode }) {
  const [s, setS] = useState<Settings>(getSettings);
  const patch = (p: Partial<Settings>) => setS(updateSettings(p));
  const models = agentModelSwitchFor(cli.id);
  const cheap = legacyRunnerFor(cli.id)?.backgroundModel;
  const field = (key: "brainModel" | "brainBackgroundModel", label: string, fallback: string) => (
    <Field label={label}>
      {models?.kind === "inline" ? (
        <Select
          width="md"
          aria-label={label}
          value={s[key]}
          onChange={(e) => patch({ [key]: e.target.value })}
        >
          <option value="">{fallback}</option>
          {models.choices.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — {m.hint}
            </option>
          ))}
        </Select>
      ) : (
        // A per-account catalogue has no list Canopy can be right about (see
        // agentModels.ts), so it takes a name rather than offering a wrong one.
        <TextInput
          width="md"
          aria-label={label}
          placeholder={fallback}
          value={s[key]}
          onChange={(e) => patch({ [key]: e.target.value })}
        />
      )}
    </Field>
  );
  return (
    <Row className="brain-models">
      {before}
      {field("brainModel", "Main model", `${cli.name} default`)}
      {field(
        "brainBackgroundModel",
        "Background model",
        cheap ? `${cheap} (cheaper, default)` : `${cli.name} default`,
      )}
    </Row>
  );
}

export interface BrainConnectPanelProps {
  /** A terminal opened for an install or sign-in. Modal hosts close here so
   *  the person can actually reach it. */
  onTerminalOpened?: () => void;
  /** Hide the model pickers (the first-run step keeps to one decision). */
  hideModels?: boolean;
}

export function BrainConnectPanel({ onTerminalOpened, hideModels = false }: BrainConnectPanelProps) {
  const conn = useBrainConnection();
  const { installed, loaded } = useInstalled();
  const has = (bin: string) => Boolean(installed[bin]);
  const candidates = brainCandidates(has);
  const [presets, setPresets] = useState<AcpPreset[]>([]);
  useEffect(() => {
    let live = true;
    void installableAcpPresets().then((p) => live && setPresets(p));
    return () => {
      live = false;
    };
  }, [installed]);
  const recommended = recommendedBrain(has);
  const current = installedBrain(has);
  const brain = current && candidates.includes(current) ? current : null;
  /** The command to run by hand when no project is open to host a terminal. */
  const [manual, setManual] = useState<string | null>(null);

  // Check once on arrival when nobody has yet: the person opened this to find
  // out, and "not checked" is not an answer.
  useEffect(() => {
    if (loaded && candidates.length > 0 && conn.state === "unknown") void checkBrainConnection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // A result from a CLI that is not the selected brain (the last check ran
  // before a switch) must never be shown under the selected one's name.
  const stale = Boolean(brain && conn.cli && conn.cli !== brain.id && conn.state !== "missing");
  const text = brainStateText(
    stale ? { state: "unknown", label: brain!.name } : { ...conn, label: brain?.name ?? conn.label },
  );
  useEffect(() => {
    if (stale && conn.state !== "checking") void checkBrainConnection();
  }, [stale, conn.state]);
  const missingWithChoices = conn.state === "missing" && candidates.length > 0;
  const detail = missingWithChoices
    ? `${conn.label ?? "The selected agent"} can't power Canopy's features. Pick one below.`
    : text.detail;

  const signIn = (cli: AgentCli) => {
    if (startBrainSignIn(cli)) {
      setManual(null);
      onTerminalOpened?.();
    } else setManual(signInSteps(cli));
  };
  const install = (cli: AgentCli) => {
    if (startBrainInstall(cli)) {
      setManual(null);
      onTerminalOpened?.();
    } else if (cli.install) {
      setManual(`Run \`${cli.install}\` in a terminal, then press Check again.`);
    }
  };

  const menu = useContextMenu();
  // An adapter for an agent already in the list is the same model by another
  // route: nothing the brain gains. Settings → Agents still adds one.
  const extras = presets.filter((p) => !candidates.some((c) => p.id === `${c.id}-acp`));
  const installable = brainCapableClis().filter((c) => c.install);

  /** The one place the brain is chosen. A plain switch between agents already
   *  in the list, so arrowing through it is safe. */
  const agentField = candidates.length > 0 && (
    <Field label="Agent">
      <Select
        width="md"
        aria-label="Brain"
        value={brain?.id ?? ""}
        onChange={(e) => e.target.value && void chooseBrain(e.target.value)}
      >
        {!brain && <option value="">Choose…</option>}
        {candidates.map((cli) => (
          <option key={cli.id} value={cli.id}>
            {cli.name}
          </option>
        ))}
      </Select>
    </Field>
  );
  /** Agents found on this computer that are not in the list yet. Picking one
   *  adds it, so it is a menu (commits on click or Enter), never a select. */
  const addAgent = extras.length > 0 && (
    <Button
      aria-haspopup="menu"
      title="Agents found on this computer that are not in your list yet"
      onClick={(e) =>
        menu.openUnder(
          e,
          extras.map((p) => ({ label: p.name, onClick: () => void chooseBrain(addAcpPreset(p)) })),
        )
      }
    >
      Add agent…
    </Button>
  );

  return (
    <div className="brain-connect" data-state={conn.state}>
      <div className="brain-connect-status" role="status" aria-live="polite">
        <span className={`brain-dot is-${text.tone}`} aria-hidden />
        <strong>{brain?.name ?? conn.label ?? "Brain"}</strong>
        <span className="brain-connect-short">{missingWithChoices ? "Not connected" : text.short}</span>
        {candidates.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="brain-connect-check"
            disabled={conn.state === "checking"}
            onClick={() => void checkBrainConnection()}
          >
            {conn.state === "unknown" ? "Check connection" : "Check again"}
          </Button>
        )}
      </div>
      {conn.state !== "connected" && conn.state !== "checking" && conn.state !== "unknown" && detail && (
        <p className="brain-connect-detail">{detail}</p>
      )}
      {!stale && conn.message && conn.state !== "connected" && conn.state !== "checking" && (
        <code className="brain-connect-error" title="What the CLI said">
          {conn.message.slice(0, 280)}
        </code>
      )}

      {/* Agent and its two models: one row, one width, one baseline. */}
      {!hideModels && brain ? (
        <BrainModels
          cli={brain}
          before={
            <>
              {agentField}
              {addAgent}
            </>
          }
        />
      ) : (
        (agentField || addAgent) && (
          <Row>
            {agentField}
            {addAgent}
          </Row>
        )
      )}

      {loaded && candidates.length === 0 && installable.length > 0 && (
        <div className="brain-connect-install">
          <span>Install one to give Canopy a brain:</span>
          <Row>
            <Button variant="accent" onClick={() => install(installable[0])}>
              Install {installable[0].name}
            </Button>
            {installable.length > 1 && (
              <Button
                aria-haspopup="menu"
                onClick={(e) =>
                  menu.openUnder(
                    e,
                    installable.slice(1).map((cli) => ({ label: `Install ${cli.name}`, onClick: () => install(cli) })),
                  )
                }
              >
                Another agent…
              </Button>
            )}
          </Row>
        </div>
      )}

      {((missingWithChoices && recommended) || (conn.state === "signed-out" && brain)) && (
        <Row className="brain-connect-actions">
          {missingWithChoices && recommended && (
            <Button variant="accent" onClick={() => void chooseBrain(recommended.id)}>
              Use {recommended.name}
            </Button>
          )}
          {conn.state === "signed-out" && brain && (
            <Button variant="accent" onClick={() => signIn(brain)}>
              Sign in to {brain.name}
            </Button>
          )}
        </Row>
      )}
      {conn.state === "signed-out" && brain && !manual && (
        <p className="brain-connect-hint">
          Finish sign-in in the terminal.
        </p>
      )}
      {manual && (
        <p className="brain-connect-hint" role="note">
          No project is open to host a terminal yet. {manual}
        </p>
      )}
      {menu.menu && (
        <ContextMenu x={menu.menu.x} y={menu.menu.y} items={menu.menu.items} onClose={menu.close} />
      )}
    </div>
  );
}

/** The single call to action an intelligent surface shows instead of doing
 *  nothing while the brain isn't connected. */
export function ConnectBrainCta({ what }: { what?: string }) {
  return (
    <span className="brain-cta">
      <span className="brain-dot is-bad" aria-hidden />
      <span>{what ? `${what} needs your brain.` : "Canopy's smart features need a brain."}</span>
      <Button size="sm" variant="accent" onClick={openBrainConnect}>
        Connect your brain
      </Button>
    </span>
  );
}

/**
 * Mounted once in App: wires the connection to its events, probes at start,
 * and opens the connect dialog when anything asks for it.
 */
export function BrainConnectHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => initBrainConnect(), []);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_BRAIN_CONNECT_EVENT, show);
    return () => window.removeEventListener(OPEN_BRAIN_CONNECT_EVENT, show);
  }, []);
  useEscape(() => setOpen(false), open);
  if (!open) return null;
  return (
    <div className="confirm-backdrop" onMouseDown={() => setOpen(false)}>
      <div
        className="confirm brain-connect-dialog"
        role="dialog"
        aria-label="Connect your brain"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="set-head">Connect your brain</div>
        <BrainConnectPanel onTerminalOpened={() => setOpen(false)} />
        <Row className="brain-connect-dialog-actions">
          <Button onClick={() => setOpen(false)}>Close</Button>
        </Row>
      </div>
    </div>
  );
}
