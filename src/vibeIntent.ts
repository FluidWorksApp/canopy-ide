// The invocation path the managed abstractions never had.
//
// planInstall, planLink and planDeploy were built, tested, merged — and
// callable by nobody. The agent's tool policy allows Edit, Write, Read, Grep
// and Glob and nothing else, deliberately, so the agent cannot install a
// package or publish a site even if it wanted to. That leaves exactly one
// party who can ask: the person typing.
//
// So this reads the user's own message, and only theirs. Two rules keep that
// from becoming a guessing game:
//
//   - Silence is the default. An unrecognised message is a build request and
//     goes to the agent untouched, which is what almost every message is.
//     Over-matching here would hijack "add a login button" into an install.
//   - A match is a PROPOSAL, never an action. Every intent goes through the
//     existing confirmation channel, so a wrong guess costs one decline
//     rather than an unwanted change to someone's project.

import type { DeployTarget } from "./vibeDeploy";
import type { PackageRequest } from "./vibePackages";

export type VibeIntent =
  | { kind: "install"; packages: PackageRequest[] }
  | { kind: "link"; provider: string }
  | { kind: "deploy"; target: DeployTarget };

/** Verbs that mean "bring a dependency in". Deliberately excludes bare "add",
 *  which is overwhelmingly used for features — "add a login button" must not
 *  become an install. */
const INSTALL =
  /^(?:install|add(?:\s+the)?\s+(?:package|dependency|library|npm\s+package)|npm\s+install|pnpm\s+add|yarn\s+add)\s+(.+)$/i;

/** A dev dependency, said the way people actually say it. */
const DEV = /\b(?:as\s+a\s+)?dev(?:\s+|-)?(?:dependency|dep)\b|--save-dev\b|\s-D\b/i;

/** The verb and the provider may have words between them — "hook this up to
 *  Neon" — so a short gap is allowed, but a bounded one: across a long
 *  sentence the two would stop being related to each other. */
const LINK =
  /\b(?:connect|link|set\s*up|hook\s+\w*\s*up|wire\s+\w*\s*up)\b[^.!?]{0,40}?\b(supabase|neon|firebase|stripe)\b/i;

/** The verb must be a request, not a subject.
 *
 *  The two ways this parser can be wrong are NOT symmetric, and the asymmetry
 *  is deliberate rather than an accident of tuning — do not "improve" recall
 *  here without reading this. Missing "hook this up to Neon" is a false
 *  negative: the user repeats themselves once. Reading "deploy is failing in
 *  CI" as an instruction is a false positive: something goes live. A bug report
 *  is also the single most likely thing anyone types about deployment, so it is
 *  the case the parser must be most certain to ignore.
 *
 *  Hence two filters. A determiner in front makes it a noun — "the deploy",
 *  "our deploy", "that publish" are things, not requests. And a copula or a
 *  failure word after it makes the sentence a report about the world rather
 *  than a request directed at the assistant. */
const DEPLOY_VERB =
  /(?<!\b(?:the|our|a|an|this|that|my|your|its|last|next|first|each|every)\s)\b(?:deploy|publish|ship)\b(?!\s+(?:is|was|isn't|wasn't|are|were|has|have|had|takes|took|keeps|kept|failed|fails|failing|broke|broken|works|worked))/i;
const PRODUCTION = /\b(?:production|prod|live)\b/i;
const GO_LIVE = /\bgo\s+live\b/i;

/** A package spec as typed: `stripe`, `stripe@^5`, `@scope/name@latest`. */
function parseSpec(raw: string, dev: boolean): PackageRequest | null {
  const token = raw.trim().replace(/[,.;]+$/, "");
  if (!token) return null;
  const at = token.lastIndexOf("@");
  // A leading @ is a scope, not a version separator.
  if (at > 0) {
    return { name: token.slice(0, at), version: token.slice(at + 1), dev };
  }
  return { name: token, dev };
}

/** What the user asked Canopy to do, or null when they were talking to the
 *  agent — which is almost always. */
export function parseVibeIntent(message: string): VibeIntent | null {
  const text = message.trim();
  if (!text) return null;

  const install = INSTALL.exec(text);
  if (install) {
    const dev = DEV.test(text);
    const list = install[1]
      .replace(DEV, "")
      .split(/[\s,]+and\s+|[\s,]+/)
      .map((token) => parseSpec(token, dev))
      .filter((p): p is PackageRequest => p !== null);
    return list.length > 0 ? { kind: "install", packages: list } : null;
  }

  const link = LINK.exec(text);
  if (link) return { kind: "link", provider: link[1].toLowerCase() };

  // Production is tested first: "publish to production" satisfies the preview
  // reading too, and the stricter one must win — it is the reading that asks
  // for confirmation before anything reaches users.
  if (GO_LIVE.test(text)) return { kind: "deploy", target: "production" };
  if (DEPLOY_VERB.test(text)) {
    return {
      kind: "deploy",
      target: PRODUCTION.test(text) ? "production" : "preview",
    };
  }

  return null;
}
