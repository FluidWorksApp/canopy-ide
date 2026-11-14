// A run command as a person would type it.
//
// Commands Canopy detects are stored as quoted words (`"npm" "run" "test"`,
// vibeProjectSetup.ts displayArgv), which is exact but reads like data. When
// every word is one a shell passes through untouched, the quotes say nothing,
// so they are dropped for display. Anything else is shown as stored: a word
// with a space, a `$`, a glob or a quote keeps its quoting, because there the
// quotes are the meaning.

const QUOTED_WORDS = /^"(?:[^"\\]|\\.)*"(?: "(?:[^"\\]|\\.)*")*$/;
const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function readableCommand(command: string): string {
  if (!QUOTED_WORDS.test(command)) return command;
  let words: unknown;
  try {
    words = JSON.parse(`[${command.replace(/" "/g, '","')}]`);
  } catch {
    return command;
  }
  if (!Array.isArray(words) || !words.every((w) => typeof w === "string" && PLAIN_WORD.test(w))) {
    return command;
  }
  return words.join(" ");
}
