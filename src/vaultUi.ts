// The small decisions the vault screen makes about how a credential looks and
// how a new one starts out. Here rather than in the component because each one
// is a rule worth being able to state and test on its own.

/** The letter on a credential's tile. Names come from the user, so this has to
 *  survive an empty one, a leading emoji, and a domain used as the name. */
export function monogram(label: string, domain: string): string {
  const source = (label.trim() || domain.trim()).replace(/^[^\p{L}\p{N}]+/u, "");
  return (source[0] ?? "?").toUpperCase();
}

/** A stable hue per site, so the tiles read as a set of distinct things rather
 *  than a column of identical squares — and so the same site keeps its colour
 *  between sessions. Hashed from the domain, not the name: renaming "GitHub" to
 *  "Work GitHub" should not repaint it. */
export function tint(domain: string): number {
  let hash = 0;
  for (const ch of domain.trim().toLowerCase()) {
    hash = (hash * 31 + ch.codePointAt(0)!) % 360;
  }
  return hash;
}

/** The site a new entry should start with, given the page the user has open.
 *  Adding a login while looking at its sign-in page is the common case, and
 *  typing the domain again is work the screen can do. */
export function suggestedDomain(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    // A bare www is never what the user means by "the site".
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return "";
  }
}

/** A name for a site, when the user has not typed one: the domain without its
 *  public suffix, capitalised. "github.com" -> "Github", "db.staging.internal"
 *  -> "Db staging". Only ever a starting point — the field stays editable. */
export function suggestedLabel(domain: string): string {
  const parts = domain.split(".").filter(Boolean);
  if (parts.length === 0) return "";
  const stem = parts.length > 1 ? parts.slice(0, -1) : parts;
  return stem
    .join(" ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** Characters a generated password is built from: no 0/O/1/l/I, because these
 *  get read aloud, typed by hand, and dictated more often than anyone plans
 *  for. Punctuation is limited to what every login form accepts. */
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%^&*-_=+";

/** A password from the platform CSPRNG. Rejection sampling rather than a
 *  modulo, which would quietly favour the first 40 characters of the alphabet. */
export function generatePassword(length = 20): string {
  const out: string[] = [];
  const limit = 256 - (256 % ALPHABET.length);
  const buf = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (out.length >= length) break;
      if (byte < limit) out.push(ALPHABET[byte % ALPHABET.length]);
    }
  }
  return out.join("");
}
