// First-run setup. Five full-window steps, each one real setup rather than a
// tour: meet Canopy, connect the agent that powers it (BrainConnect.tsx),
// pick how you work / your keys / the look, see what the OS has allowed, and
// open a project.
//
// Always true: Skip and Esc leave from any step, nothing waits on the agent,
// Back keeps every choice (each one is saved as it is made), and the keyboard
// drives it: Enter continues, arrows move inside a group of choices.
//
// An install or sign-in opens a terminal in the app behind this. The flow
// steps aside to a "Continue setup" button instead of closing, so the person
// can finish there and come back to the same step.
import { useEffect, useRef, useState } from "react";
import { agentHooksInstalled } from "../ipc";
import { useBrainConnection } from "../brainConnect";
import { useEscape } from "../useEscape";
import {
  THEMES,
  type DefaultProjectLens,
  type Settings,
  type Theme,
  applyTheme,
  getSettings,
  updateSettings,
} from "../settings";
import { currentPlatform, format, SHORTCUT_PROFILES } from "../shortcuts";
import { skinDef } from "../skins/registry";
import { Ash } from "./Ash";
import { BrainConnectPanel } from "./BrainConnect";
import { OnboardingPermissions } from "./OnboardingPermissions";
import { Button } from "./ui";
import "./onboarding.css";

interface OnboardingProps {
  /** Called when setup is dismissed any way (Skip, Esc, Look around first). */
  onClose: () => void;
  /** Called instead of onClose when the user finishes and wants to start. */
  onCreateProject: () => void;
}

const STEPS = ["Welcome", "Connect your agent", "Make it yours", "Permissions", "First project"] as const;

const PLATFORM = currentPlatform();
const PLATFORM_LABEL = PLATFORM === "macos" ? "macOS" : PLATFORM === "windows" ? "Windows" : "Linux";

const LENSES: [DefaultProjectLens, string, string][] = [
  ["build", "I build with AI", "Plain words, fewer panels"],
  ["engineer", "I'm an engineer", "Code, git and terminals up front"],
];

/** A skin's swatch colours. Auto follows the OS, so it shows both ends. */
function swatch(theme: Theme): React.CSSProperties {
  if (theme === "auto") {
    const dark = skinDef("gotham").preview.bg;
    const light = skinDef("daylight").preview.bg;
    return { background: `linear-gradient(135deg, ${dark} 50%, ${light} 50%)` };
  }
  const p = skinDef(theme).preview;
  return { background: p.bg, "--ob-swatch-accent": p.accent } as React.CSSProperties;
}

/** A labelled group of native radios drawn as cards or pills. Native, so the
 *  arrow keys move the choice without any key handling here. */
function Choices<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
  className = "",
}: {
  name: string;
  label: string;
  value: T;
  options: readonly { id: T; label: string; hint?: string; style?: React.CSSProperties }[];
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={`ob-choices ${className}`.trim()} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.id} className={`ob-choice${o.id === value ? " is-on" : ""}`} style={o.style} title={o.style ? o.label : undefined}>
          <input
            type="radio"
            name={name}
            checked={o.id === value}
            onChange={() => onChange(o.id)}
            aria-label={o.label}
          />
          {!o.style && (
            <span>
              <strong>{o.label}</strong>
              {o.hint && <small>{o.hint}</small>}
            </span>
          )}
        </label>
      ))}
    </div>
  );
}

/** Says the agent's hooks are in place only when the check says so. */
function HooksLine() {
  const conn = useBrainConnection();
  const cli = conn.state === "connected" ? conn.cli : null;
  const [ready, setReady] = useState<string | null>(null);
  useEffect(() => {
    if (!cli) return;
    let live = true;
    agentHooksInstalled(cli)
      .then((ok) => live && setReady(ok ? cli : null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [cli]);
  if (!cli || ready !== cli) return null;
  return (
    <p className="ob-hint">
      <span className="ob-state is-ok">Canopy's hooks and tools are set up in {conn.label ?? "your agent"}</span>
    </p>
  );
}

export function Onboarding({ onClose, onCreateProject }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const [settings, setSettings] = useState(getSettings);
  const root = useRef<HTMLDivElement>(null);
  useEscape(onClose, !paused);

  const last = step === STEPS.length - 1;
  const patch = (next: Partial<Settings>) => setSettings(updateSettings(next));
  const pickTheme = (theme: Theme) => {
    patch({ theme });
    applyTheme(theme, settings.customAccent);
  };
  const next = () => (last ? onCreateProject() : setStep((s) => s + 1));

  // Each step starts on its main action, so Enter moves on.
  useEffect(() => {
    if (!paused) root.current?.querySelector<HTMLButtonElement>(".ob-next")?.focus();
  }, [step, paused]);

  if (paused) {
    return (
      <button type="button" className="ob-resume" onClick={() => setPaused(false)}>
        <Ash state="idle" size={18} />
        Continue setup
      </button>
    );
  }

  const profile = SHORTCUT_PROFILES.find(({ id }) => id === settings.keymapProfile);

  return (
    <div
      ref={root}
      className="ob-flow"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Canopy"
      onKeyDown={(e) => {
        if (e.key !== "Enter" || e.defaultPrevented) return;
        // A button, link or text field keeps its own Enter.
        const el = e.target as HTMLElement;
        const radio = el instanceof HTMLInputElement && el.type === "radio";
        if (!radio && el.closest("button, a, input, select, textarea")) return;
        e.preventDefault();
        next();
      }}
    >
      <header className="ob-top" data-tauri-drag-region>
        <ol className="ob-progress" aria-label="Setup progress">
          {STEPS.map((title, i) => (
            <li key={title}>
              <button
                type="button"
                className={i <= step ? "is-on" : ""}
                aria-label={`Step ${i + 1}: ${title}`}
                aria-current={i === step ? "step" : undefined}
                onClick={() => setStep(i)}
              />
            </li>
          ))}
        </ol>
        <button type="button" className="ob-skip" onClick={onClose}>
          Skip setup <kbd>esc</kbd>
        </button>
      </header>

      <main className="ob-step" data-step={step}>
        <div className="ob-step-in" key={step}>
        {step === 0 && (
          <>
            <Ash state="idle" size={132} />
            <h1>Welcome to Canopy</h1>
            <p className="ob-lead">
              Two minutes to connect your agent, pick your keys and open a project. Change any of it later in
              Settings.
            </p>
          </>
        )}

        {step === 1 && (
          <>
            <h1 className="ob-h">Connect your agent</h1>
            <p className="ob-lead">Canopy runs on an agent you already use. Summaries, titles and PR text come from it.</p>
            <div className="ob-panel">
              <BrainConnectPanel hideModels onTerminalOpened={() => setPaused(true)} />
            </div>
            <HooksLine />
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="ob-h">Make it yours</h1>
            <p className="ob-lead">Three choices. Each applies as you pick it.</p>
            <div className="ob-cards">
              <section className="ob-card">
                <h2>How you work</h2>
                <Choices
                  name="ob-lens"
                  label="How you work"
                  value={settings.defaultProjectLens}
                  options={LENSES.map(([id, label, hint]) => ({ id, label, hint }))}
                  onChange={(defaultProjectLens) => patch({ defaultProjectLens })}
                />
              </section>
              <section className="ob-card">
                <h2>Shortcuts</h2>
                <Choices
                  name="ob-keys"
                  label="Shortcut profile"
                  className="ob-pills"
                  value={settings.keymapProfile}
                  options={SHORTCUT_PROFILES.map(({ id, label }) => ({ id, label }))}
                  onChange={(keymapProfile) => patch({ keymapProfile })}
                />
                <p className="ob-keys">
                  {(
                    [
                      ["quick-open", "Quick open"],
                      ["spot-search", "Search everything"],
                      ["settings", "Settings"],
                    ] as const
                  ).map(([id, label]) => (
                    <span key={id}>
                      {label} <kbd data-shortcut={id}>{format(id, PLATFORM, settings.keymapProfile)}</kbd>
                    </span>
                  ))}
                </p>
                <small data-shortcut-platform>
                  {profile?.description.replace(/\.$/, "")}. Shown for {PLATFORM_LABEL}.
                </small>
              </section>
              <section className="ob-card">
                <h2>Look</h2>
                <Choices
                  name="ob-skin"
                  label="Look"
                  className="ob-swatches"
                  value={settings.theme}
                  options={THEMES.map((t) => ({ id: t.id, label: t.label, style: swatch(t.id) }))}
                  onChange={pickTheme}
                />
                <small>{THEMES.find((t) => t.id === settings.theme)?.label}. The window changes as you pick.</small>
              </section>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h1 className="ob-h">Permissions</h1>
            <p className="ob-lead">What Canopy and your agents can use on this computer, as it stands now.</p>
            <OnboardingPermissions />
          </>
        )}

        {step === 4 && (
          <>
            <Ash state="celebrating" size={88} />
            <h1 className="ob-h">You're set</h1>
            <p className="ob-lead">
              A project is a folder, or several that belong together. Open one from this computer or clone a
              repository.
            </p>
          </>
        )}
        </div>
      </main>

      <footer className="ob-foot">
        {step > 0 && (
          <Button className="ob-back" aria-label="Back" onClick={() => setStep((s) => s - 1)}>
            ←
          </Button>
        )}
        <Button variant="accent" className="ob-next" onClick={next}>
          {step === 0 ? "Get started" : last ? "Create a project" : "Continue"} <kbd>↵</kbd>
        </Button>
        {last && (
          <Button className="ob-later" onClick={onClose}>
            Look around first
          </Button>
        )}
      </footer>
    </div>
  );
}
