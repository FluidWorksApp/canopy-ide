// A launcher badge for a CLI installed below the oldest version Canopy's
// launches are written for (harness.ts HARNESS_MIN_VERSION). Renders nothing
// when the version is fine, unknown, or the CLI has no floor.
import { HARNESS_MIN_VERSION, harnessVersionWarning } from "../harness";

export function CliVersionFloor({
  cliId,
  installed,
}: {
  cliId: string;
  installed: string | undefined;
}) {
  const warning = harnessVersionWarning(cliId, installed);
  if (!warning) return null;
  return (
    <span className="cli-floor" title={`${warning} Update it to use rollback and headless runs safely.`}>
      needs {HARNESS_MIN_VERSION[cliId].version}+
    </span>
  );
}
