import { binName, type AgentCli } from "./projects";

export const GIB = 1024 ** 3;

export const AGENT_MEMORY_MAXIMUM_CHOICES = [
  0.5,
  1,
  1.5,
  2,
  3,
  4,
  6,
  8,
  12,
  16,
].map((gib) => gib * GIB);

/** Matches governor::cli_key without retaining an executable path. Package
 * identity survives enterprise wrappers; opaque CLIs use the folded basename. */
export function agentMemoryKeys(
  cli: Pick<AgentCli, "bin" | "pkgs">,
): string[] {
  const packages = cli.pkgs
    ?.map((pkg) => pkg.trim().toLowerCase())
    .filter(Boolean);
  return packages?.length
    ? packages.map((pkg) => `pkg:${pkg}`)
    : [`bin:${binName(cli.bin)}`];
}
