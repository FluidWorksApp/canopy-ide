// Compact number formats shared by every place tokens are shown — the status
// tray, its usage popover, the stats panel and the workspace header — so the
// same session reads the same everywhere.

const TOKEN_UNITS: { at: number; suffix: string; digits: number }[] = [
  { at: 1e12, suffix: "T", digits: 2 },
  { at: 1e9, suffix: "B", digits: 2 },
  { at: 1e6, suffix: "M", digits: 1 },
  { at: 1e3, suffix: "k", digits: 1 },
];

/** Token counts run from a handful to trillions across a long-lived install,
 *  so scale the unit rather than printing a five-digit "M". `compact` drops
 *  the decimal on thousands for the status tray, where width is tight. */
export const fmtTokens = (n: number, compact = false): string => {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  for (const u of TOKEN_UNITS) {
    if (abs >= u.at) {
      const digits = compact && u.suffix === "k" ? 0 : u.digits;
      return `${sign}${(abs / u.at).toFixed(digits)}${u.suffix}`;
    }
  }
  return `${n}`;
};
