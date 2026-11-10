import { agentCliFor } from "../projects";

/** "Use ACP" for one agent. On unless the stored value is an explicit false,
 *  matching how the runner resolver reads it. Renders nothing for an agent
 *  with no ACP entrypoint, so the row never offers a switch that does nothing. */
export function AcpAgentToggle({
  cliId,
  name,
  value,
  onChange,
}: {
  cliId: string;
  name: string;
  value: boolean | undefined;
  onChange: (cliId: string, on: boolean) => void;
}) {
  const cli = agentCliFor(cliId);
  if (!cli?.acpRunner) return null;
  const hasFallback = Boolean(cli.structuredRunner && cli.structuredRunner !== cli.acpRunner);
  return (
    <label className="set-inline-check has-hint">
      <input
        type="checkbox"
        aria-label={`Use ACP for ${name}`}
        checked={value !== false}
        onChange={(e) => onChange(cliId, e.target.checked)}
      />
      <span>
        {name}
        <em>{hasFallback ? "Off uses the built-in runner." : "Off leaves it terminal-only."}</em>
      </span>
    </label>
  );
}
