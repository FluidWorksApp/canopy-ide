import { useState } from "react";
import { ACP_PRESETS } from "../acp/providers";
import {
  fetchAcpRegistry,
  AcpRegistryError,
  type RegistryAgent,
  type RegistryLaunch,
} from "../acp/registry";
import type { CustomAcpConfig } from "../acp/providers";

export interface AcpProviderChoice {
  name: string;
  bin: string;
  acp: CustomAcpConfig;
}

/** One-click presets plus a registry browser. Choosing only calls `onAdd`: the
 *  parent adds an ordinary custom row, and nothing is installed or run here. */
export function AcpProviderPicker({
  onAdd,
  fetchImpl,
}: {
  onAdd: (choice: AcpProviderChoice) => void;
  fetchImpl?: typeof fetch;
}) {
  const [agents, setAgents] = useState<RegistryAgent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const browse = async () => {
    setBusy(true);
    setNote("");
    try {
      setAgents(await fetchAcpRegistry({ fetchImpl }));
    } catch (e) {
      setAgents(null);
      setNote(
        e instanceof AcpRegistryError && e.reason === "invalid"
          ? "The ACP registry returned something unreadable. The built-in presets still work."
          : "Couldn't reach the ACP registry. The built-in presets still work.",
      );
    } finally {
      setBusy(false);
    }
  };

  const addLaunch = (a: RegistryAgent, l: RegistryLaunch) =>
    onAdd({ name: a.name, bin: l.command, acp: { args: l.args, ...(l.env ? { env: l.env } : {}) } });

  return (
    <div className="acp-picker" role="group" aria-label="Add an ACP provider">
      <div className="acp-picker-presets">
        {ACP_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="agent-chip"
            title={`${p.bin} ${p.args.join(" ")} (verified ${p.verifiedOn}). Install: ${p.install}`}
            aria-label={`Add ${p.name} as an ACP provider`}
            onClick={() => onAdd({ name: p.name, bin: p.bin, acp: { args: [...p.args] } })}
          >
            ＋ {p.name}
          </button>
        ))}
        <button
          type="button"
          className="agent-chip"
          disabled={busy}
          aria-label="Browse the ACP registry"
          onClick={() => void browse()}
        >
          {busy ? "Loading registry…" : "Browse ACP registry"}
        </button>
      </div>
      {note && (
        <div className="cli-custom-hint" role="status">
          {note}
        </div>
      )}
      {agents && (
        <ul className="acp-registry-list" aria-label="ACP registry agents">
          {agents.map((a) => (
            <li key={a.id} className="acp-registry-row">
              <span title={a.description}>
                {a.name} <span className="cli-custom-hint">{a.version}</span>
              </span>
              {a.launch.map((l) => (
                <button
                  key={l.kind}
                  type="button"
                  className="agent-chip"
                  aria-label={`Add ${a.name} via ${l.kind}`}
                  title={
                    l.needsInstall
                      ? `Needs ${l.command} installed on your PATH`
                      : `Runs ${l.command} ${l.args.join(" ")} when you start it`
                  }
                  onClick={() => addLaunch(a, l)}
                >
                  ＋ {l.kind}
                </button>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
