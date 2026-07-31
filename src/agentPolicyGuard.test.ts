// One definition per threshold, across both languages.
//
// Before `policy.json` there were six silence windows answering one family of
// questions — 6s, 60s, 300s, 600s, 900s, 1800s — and four CPU cut points on the
// same `total_cpu`: 0, 2, 10 and 300. Two of the 1800s were hand-copied
// literals in different files, each with a comment admitting it mirrored the
// other. That is the state this test exists to prevent returning to.
/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { POLICY } from "../shared/agentLife";

const ROOT = process.cwd();
const ROOTS = ["src", "shared", "portal/src", "src-tauri/src"];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === "target") continue;
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|rs)$/.test(full)) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(join(ROOT, r)))
  .map((f) => relative(ROOT, f))
  .filter((f) => !/\.test\.(ts|tsx)$/.test(f))
  .filter((f) => !f.startsWith("shared/agentLife/"))
  .filter((f) => f !== "src/agentLifeStore.ts");

const codeLines = (rel: string): string[] =>
  readFileSync(join(ROOT, rel), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    });

describe("every lifecycle threshold has exactly one definition", () => {
  it("names no second peer-age constant", () => {
    // canopy_hook.rs, AgentsPanel.tsx and portal.rs each had their own literal
    // for this. Two of the three said in a comment that they mirrored a third.
    const hits: string[] = [];
    for (const rel of files) {
      for (const l of codeLines(rel)) {
        if (/PEER_MAX_AGE_SECS\s*(:|=)\s*(30\s*\*\s*60|1800)/.test(l))
          hits.push(`${rel}: ${l.trim()}`);
        if (/RECENT_SECS\s*:\s*u64\s*=\s*(30\s*\*\s*60|1800)/.test(l))
          hits.push(`${rel}: ${l.trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("names no second silence window", () => {
    const hits: string[] = [];
    for (const rel of files) {
      for (const l of codeLines(rel)) {
        if (/STALE_AFTER_SECS|QUIET_CPU_PERCENT/.test(l)) hits.push(`${rel}: ${l.trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("keeps the policy readable from both languages", () => {
    // If the Rust side stops finding a field it silently falls back to its
    // hard-coded defaults, which is safe and invisible — so assert the shapes
    // match rather than trusting that.
    expect(POLICY.quietCpuPercent).toBe(2);
    expect(POLICY.hookTrustSecs).toBe(300);
    expect(POLICY.peerMaxAgeSecs).toBe(1800);
    const rs = readFileSync(
      join(ROOT, "src-tauri/src/agent_life.rs"),
      "utf8",
    );
    for (const field of [
      "quietCpuPercent",
      "quietOutputMs",
      "answerWindowMs",
      "hookTrustSecs",
      "startupGraceSecs",
      "peerMaxAgeSecs",
    ]) {
      expect(rs, `Rust must read ${field}`).toContain(`rename = "${field}"`);
    }
  });
});
