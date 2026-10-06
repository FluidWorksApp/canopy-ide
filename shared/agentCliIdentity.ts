/**
 * Durable agent identity shared by desktop and portal projections.
 *
 * This is a storage key, not a vendor name or executable. Product names and
 * binaries may change independently in the CLI registry. Keep the key for old
 * state; use registry aliases if a key itself ever has to be retired.
 */
export const DEFAULT_AGENT_CLI_ID = "claude";
