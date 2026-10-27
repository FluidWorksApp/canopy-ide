// Settings → Agents → Brain: the parts of the brain's settings that are not
// the connect panel itself — features that run on something else by choice,
// and the automatic brain work that can be switched off.

import { useEffect, useState, useSyncExternalStore } from "react";
import { brainExceptions } from "../brainConnect";
import { checkDesktopClis, CLI_INSTALLS_CHANGED_EVENT } from "../projects";
import { getSettings, subscribeSettings, updateSettings } from "../settings";
import { Button, Checkbox } from "./ui";
import "./brainConnect.css";

function useDesktopInstalled(): Record<string, boolean> {
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let live = true;
    const pull = () =>
      void checkDesktopClis().then((found) => {
        if (live) setInstalled(found);
      });
    pull();
    window.addEventListener(CLI_INSTALLS_CHANGED_EVENT, pull);
    return () => {
      live = false;
      window.removeEventListener(CLI_INSTALLS_CHANGED_EVENT, pull);
    };
  }, []);
  return installed;
}

/**
 * Every feature that uses something other than the brain, each with a way
 * back. `only` narrows it to one feature, for showing the exception beside
 * that feature's own controls (the companion's row in Mascot).
 */
export function BrainExceptions({ only }: { only?: string }) {
  const settings = useSyncExternalStore(subscribeSettings, getSettings, getSettings);
  const installed = useDesktopInstalled();
  const all = brainExceptions(settings, (bin) => Boolean(installed[bin]));
  const list = only ? all.filter((e) => e.feature === only) : all;
  if (list.length === 0) {
    return only ? null : (
      <span className="set-item-desc">Every feature uses your brain.</span>
    );
  }
  return (
    <>
      {list.map((e) => (
        <div key={e.feature} className="brain-exception" role="note">
          <span>
            <strong>{e.feature}</strong> uses {e.uses} instead of your brain.
          </span>
          <Button size="sm" onClick={() => updateSettings(e.reset)}>
            Use my brain
          </Button>
        </div>
      ))}
    </>
  );
}

/** The automatic brain work, each switchable off. */
export function BrainAutomation() {
  const settings = useSyncExternalStore(subscribeSettings, getSettings, getSettings);
  return (
    <Checkbox
      checked={settings.brainSessionTitles}
      onChange={(v) => updateSettings({ brainSessionTitles: v })}
      label="Let the brain name sessions"
      hint={
        settings.brainSessionTitles
          ? "When an agent doesn't name its own task, the brain titles its tab and writes the one-line summary in Agents. One small background call per new session."
          : "Tabs keep the first words of the opening prompt, and Agents shows the latest message."
      }
    />
  );
}
