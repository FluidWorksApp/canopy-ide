# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

- Preferred: [GitHub private vulnerability reporting](https://github.com/FluidWorksApp/canopy-ide/security/advisories/new)
  (the **Report a vulnerability** button on the Security tab).
- Or email **sam@fluidwords.app** with the details.

Include, as best you can:

- what the issue is and the impact you think it has,
- steps to reproduce (a proof of concept helps a lot),
- affected version / commit and your OS.

We aim to acknowledge a report within a few days and to keep you updated as we
work on a fix. Please give us a reasonable chance to release a fix before any
public disclosure.

## What's in scope

Canopy is a local-first desktop app: it spawns processes (shells, agent CLIs,
language servers), watches and edits the filesystem, and installs shell hooks.
Issues that are especially relevant:

- escaping the workspace scope allowlist (reading/writing outside opened projects),
- command or argument injection into spawned processes,
- the auto-updater (signature bypass, downgrade, or MITM of the update feed),
- the agent-hook bridge writing or reading outside its intended paths.

## Supported versions

Canopy is pre-1.0 and ships from a single line of development. Security fixes
land on the latest release; please upgrade to the newest build before reporting.
