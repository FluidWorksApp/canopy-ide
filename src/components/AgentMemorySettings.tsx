import { useEffect, useState } from "react";
import {
  AGENT_MEMORY_MAXIMUM_CHOICES,
  agentMemoryKeys,
} from "../agentMemory";
import { fmtBytes } from "../cleanup";
import * as ipc from "../ipc";
import { AGENT_CLIS, type AgentCli } from "../projects";
import { AgentIcon } from "./icons";
import { Select } from "./ui";

type MemoryAgent = Pick<AgentCli, "id" | "name" | "bin" | "pkgs">;

export function AgentMemorySettings({
  agents = AGENT_CLIS,
  load = ipc.terminalGovernorMemoryMaxima,
  save = ipc.terminalGovernorSetMemoryMaximum,
}: {
  agents?: readonly MemoryAgent[];
  load?: () => Promise<ipc.AgentMemoryMaximum[]>;
  save?: (
    cliKey: string,
    maxAllowanceBytes: number | null,
  ) => Promise<ipc.AgentMemoryMaximum[]>;
}) {
  const [maxima, setMaxima] = useState<ipc.AgentMemoryMaximum[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void load()
      .then((values) => {
        if (!cancelled) setMaxima(values);
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const byKey = new Map(
    maxima.map((value) => [value.cli_key, value.max_allowance_bytes]),
  );

  return (
    <div className="agent-memory-settings">
      {agents.map((agent) => {
        const keys = agentMemoryKeys(agent);
        const key = keys[0];
        const maximum = keys.flatMap((candidate) => {
          const value = byKey.get(candidate);
          return value == null ? [] : [value];
        })[0] ?? 0;
        return (
          <label key={agent.id} className="agent-memory-setting-row">
            <span>
              <AgentIcon id={agent.id} size={15} />
              {agent.name}
            </span>
            <Select
              aria-label={`${agent.name} maximum memory allowance`}
              width="sm"
              size="sm"
              value={maximum}
              disabled={busyKey === key}
              onChange={(event) => {
                const selected = Number(event.currentTarget.value);
                setBusyKey(key);
                setError(null);
                void keys.reduce(
                  (pending, candidate) => pending.then(() =>
                    save(candidate, selected === 0 ? null : selected).then(() => undefined),
                  ),
                  Promise.resolve(),
                )
                  .then(load)
                  .then(setMaxima)
                  .catch((cause) => setError(String(cause)))
                  .finally(() => setBusyKey(null));
              }}
            >
              <option value={0}>Automatic</option>
              {maximum !== 0 &&
                !AGENT_MEMORY_MAXIMUM_CHOICES.includes(maximum) && (
                  <option value={maximum}>{fmtBytes(maximum)}</option>
                )}
              {AGENT_MEMORY_MAXIMUM_CHOICES.map((bytes) => (
                <option key={bytes} value={bytes}>{fmtBytes(bytes)}</option>
              ))}
            </Select>
          </label>
        );
      })}
      <p className="set-item-desc">
        These values cap future allowance grants for each agent on this device.
        Canopy still only monitors memory unless the platform capability above
        explicitly says otherwise.
      </p>
      {error && <p className="set-danger-note" role="alert">{error}</p>}
    </div>
  );
}
