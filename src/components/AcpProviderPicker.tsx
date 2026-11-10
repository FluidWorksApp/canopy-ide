import { useEffect, useRef, useState } from "react";
import { ACP_PRESETS } from "../acp/providers";
import {
  fetchAcpRegistry,
  AcpRegistryError,
  type RegistryAgent,
  type RegistryLaunch,
} from "../acp/registry";
import type { CustomAcpConfig } from "../acp/providers";
import { trustedIconUrl } from "../acp/connectorIcons";
import { ConnectorIcon } from "./ConnectorIcon";

export interface AcpProviderChoice {
  name: string;
  bin: string;
  acp: CustomAcpConfig;
  /** The connector's registry icon, remembered so the launcher can draw it. */
  icon?: string;
}

const registryIcon = (id: string) =>
  trustedIconUrl(`https://cdn.agentclientprotocol.com/registry/v1/latest/${id}.svg`);

/** A dropdown of ACP connectors: Canopy's verified presets first, then the
 *  registry's. Choosing only calls `onAdd`: the parent adds an ordinary custom
 *  row, and nothing is installed or run here. A registry entry shows exactly
 *  what will run before it is stored, because the registry JSON is unsigned. */
export function AcpProviderPicker({
  onAdd,
  fetchImpl,
}: {
  onAdd: (choice: AcpProviderChoice) => void;
  fetchImpl?: typeof fetch;
}) {
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<RegistryAgent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<AcpProviderChoice | null>(null);
  const [choosing, setChoosing] = useState<RegistryAgent | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const load = async () => {
    if (agents || busy) return;
    setBusy(true);
    setNote("");
    try {
      setAgents(await fetchAcpRegistry({ fetchImpl }));
    } catch (e) {
      setNote(
        e instanceof AcpRegistryError && e.reason === "invalid"
          ? "Registry unreadable; presets still work."
          : "Registry unreachable; presets still work.",
      );
    } finally {
      setBusy(false);
    }
  };

  const toggle = () => {
    setOpen((v) => !v);
    if (!open) void load();
  };

  // Close on an outside press or Escape, like any menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Close the menu only: the settings dialog behind it keeps its own Escape.
      e.stopPropagation();
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const presetIds = new Set(ACP_PRESETS.map((p) => p.id));
  const registryOnly = (agents ?? []).filter((a) => !presetIds.has(a.id));

  const stage = (a: RegistryAgent, l: RegistryLaunch) => {
    setChoosing(null);
    setPending({
      name: a.name,
      bin: l.command,
      acp: { args: l.args, ...(l.env ? { env: l.env } : {}) },
      icon: a.icon,
    });
  };

  const pick = (a: RegistryAgent) => {
    setOpen(false);
    if (a.launch.length === 1) stage(a, a.launch[0]);
    else setChoosing(a);
  };

  return (
    <div className="acp-picker" role="group" aria-label="Add an ACP provider" ref={root}>
      <button
        type="button"
        ref={toggleRef}
        className="agent-chip acp-picker-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        ＋ Add an ACP connector ▾
      </button>
      {open && (
        <ul className="acp-menu" role="menu" aria-label="ACP connectors">
          {ACP_PRESETS.map((p) => (
            <li key={p.id} role="none">
              <button
                type="button"
                role="menuitem"
                className="acp-menu-item"
                title={`${p.bin} ${p.args.join(" ")} (verified ${p.verifiedOn}). Install: ${p.install}`}
                aria-label={`Add ${p.name} as an ACP provider`}
                onClick={() => {
                  setOpen(false);
                  onAdd({ name: p.name, bin: p.bin, acp: { args: [...p.args] }, icon: registryIcon(p.id) });
                }}
              >
                <ConnectorIcon url={registryIcon(p.id)} size={16} />
                <span className="acp-menu-name">{p.name}</span>
                <span className="cli-custom-hint">verified</span>
              </button>
            </li>
          ))}
          {busy && (
            <li className="cli-custom-hint acp-menu-note" role="status">
              Loading registry…
            </li>
          )}
          {registryOnly.map((a) => (
            <li key={a.id} role="none">
              <button
                type="button"
                role="menuitem"
                className="acp-menu-item"
                title={a.description}
                aria-label={`Add ${a.name} from the ACP registry`}
                onClick={() => pick(a)}
              >
                <ConnectorIcon url={a.icon} size={16} />
                <span className="acp-menu-name">{a.name}</span>
                <span className="cli-custom-hint">{a.version}</span>
              </button>
            </li>
          ))}
          {note && (
            <li className="cli-custom-hint acp-menu-note" role="status">
              {note}
            </li>
          )}
        </ul>
      )}
      {choosing && (
        <div className="acp-confirm" role="group" aria-label={`Choose how to run ${choosing.name}`}>
          <div>
            How should Canopy run <strong>{choosing.name}</strong>?
          </div>
          {choosing.launch.map((l) => (
            <button
              key={l.kind}
              type="button"
              className="agent-chip"
              aria-label={`Add ${choosing.name} via ${l.kind}`}
              title={`${l.needsInstall ? `Needs ${l.command} installed on your PATH. ` : ""}Runs ${l.command} ${l.args.join(" ")} when you start it`}
              onClick={() => stage(choosing, l)}
            >
              ＋ {l.kind}
            </button>
          ))}
          <button type="button" className="agent-chip" onClick={() => setChoosing(null)}>
            Cancel
          </button>
        </div>
      )}
      {pending && (
        <div className="acp-confirm" role="group" aria-label={`Confirm adding ${pending.name}`}>
          <div>
            Canopy will run this when you start <strong>{pending.name}</strong>:
          </div>
          <code>{[pending.bin, ...pending.acp.args].join(" ")}</code>
          {pending.acp.env && (
            <div>
              Environment:{" "}
              <code>
                {Object.entries(pending.acp.env)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(" ")}
              </code>
            </div>
          )}
          <button
            type="button"
            className="agent-chip"
            onClick={() => {
              onAdd(pending);
              setPending(null);
            }}
          >
            Add {pending.name}
          </button>
          <button type="button" className="agent-chip" onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
