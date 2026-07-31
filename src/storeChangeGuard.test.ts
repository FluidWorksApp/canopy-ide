/** The class this repo keeps re-learning: something writes a store, and the
 *  surface showing it never finds out. It happened to notes because the only
 *  announcement lived in the frontend mutators, so a write by an agent — or by
 *  the portal, or by a repair routine — was silent, and the panel stayed stale
 *  until the app restarted.
 *
 *  A point fix would not have held: the next bridge verb would forget again.
 *  So the pulse lives in each store's write boundary, and this test keeps it
 *  there. It checks three things, and each one is written to fail on the shape
 *  the bug actually had rather than on a proxy for it:
 *
 *   1. Every store's write boundary pulses. Scoped to the boundary function by
 *      name, not to "any file that calls std::fs::write" — notes.rs and fsx.rs
 *      both write plenty of things that are not stores, and a rule that flags
 *      those needs an exemption list. This repo does not do exemption lists:
 *      the moment one exists, the next offender is added to it.
 *   2. Every `change::Store` variant has a handler in src/stores.ts. A variant
 *      that emits into nothing looks exactly like the bug from the outside.
 *   3. No store pulses from a function the read path calls. That is not
 *      hypothetical: a pulse in a memoising helper that only a read invokes is
 *      a refetch loop that runs forever, on no user action.
 *
 *  If you are adding a store: add the variant, pulse from its write boundary,
 *  register a handler, and add the boundary to STORES below. */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "src-tauri", "src");
const read = (f: string) => readFileSync(join(SRC, f), "utf8");

/** Each store's single write boundary: the function every mutation funnels
 *  through. `delete_boundaries` are the mutations that write no record at all
 *  and so cannot be spoken for by the main boundary. */
const STORES = [
  {
    id: "notes",
    file: "notes.rs",
    variant: "Notes",
    boundary: "write_meta",
    // Mutations that write no record, so the boundary cannot speak for them.
    delete_boundaries: ["notes_delete"],
    frontend_module: "notes.ts",
    // The fields the pulse must carry, or null for a store with a single
    // global instance and so nothing to scope by.
    record_ids: ["meta.project_id", "meta.id"],
    /** Read commands in this file. None of them may pulse: a pulse a read can
     *  reach is a refetch loop that paces itself on the settle window and runs
     *  forever on no user action. */
    read_verbs: ["_list", "_get", "_search", "_due"],
  },
  {
    id: "research",
    file: "research.rs",
    variant: "Research",
    boundary: "write_meta",
    delete_boundaries: ["research_delete"],
    frontend_module: "research.ts",
    record_ids: ["meta.project_id", "meta.id"],
    // `link_impl` ends by calling research_get, so research_get sits on the
    // tail of a write path — pulsing from it would be the loop exactly.
    read_verbs: ["_list", "_get", "_search", "_read_file", "_for_file", "_dir"],
  },
  {
    id: "vault",
    file: "vault.rs",
    // NOT `persist`, whose doc comment used to claim every mutation went
    // through it: vault_create and vault_change_passphrase seal and call
    // write_file directly. A design that trusted that comment put the pulse
    // where creating or re-keying a vault would have been silent.
    boundary: "write_file",
    variant: "Vault",
    delete_boundaries: [],
    frontend_module: "vaultStore.ts",
    // One vault, not one per project: there is no record to take ids from and
    // the pulse is correctly scopeless.
    record_ids: null,
    // vault_status and vault_list both route through VaultState::key(), which
    // postpones the auto-lock. A pulse reachable from either would mean a
    // write keeps the vault unlocked.
    read_verbs: ["_status", "_list", "_read", "_approvals"],
  },
] as const;

/** Rust comments are where the words "std::fs::write" appear most often in
 *  this codebase, and a doc comment describing a write is not a write. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** A function body, matched at any indentation so methods inside `impl` blocks
 *  are scanned too. A splitter that silently skipped them would report "clean"
 *  when it meant "not looked at", which is the failure mode this whole test
 *  exists to prevent. */
function fnBody(src: string, name: string): string | null {
  const stripped = stripComments(src);
  const start = stripped.search(new RegExp(`(^|\\s)fn\\s+${name}\\s*[(<]`, "m"));
  if (start === -1) return null;
  const open = stripped.indexOf("{", start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < stripped.length; i += 1) {
    if (stripped[i] === "{") depth += 1;
    else if (stripped[i] === "}") {
      depth -= 1;
      if (depth === 0) return stripped.slice(open, i + 1);
    }
  }
  return null;
}

describe("the store change channel", () => {
  it("pulses from every store's write boundary", () => {
    for (const store of STORES) {
      const src = read(store.file);
      for (const fn of [store.boundary, ...store.delete_boundaries]) {
        const body = fnBody(src, fn);
        // A missing boundary fails loudly rather than passing vacuously: a
        // renamed function must not read as a clean scan.
        expect(body, `${store.file}: no fn ${fn} — did it get renamed?`).not.toBeNull();
        expect(
          body,
          `${store.file}: ${fn} is ${store.id}'s write boundary and must call change::pulse, ` +
            `or a write by an agent or the portal reaches no open surface`,
        ).toContain("change::pulse");
      }
    }
  });

  it("pulses with the record's own ids, never derived from the path", () => {
    // Deriving scope from directory components is correct until a layout
    // changes, and then it is silently wrong. Every record carries both ids.
    for (const store of STORES) {
      const body = fnBody(read(store.file), store.boundary) ?? "";
      for (const field of store.record_ids ?? []) {
        expect(body, `${store.file}: ${store.boundary} must pulse with ${field}`).toContain(field);
      }
      // Never derived from where the file happens to sit, for any store.
      expect(
        body,
        `${store.file}: ${store.boundary} derives a value from the path — use the record's fields`,
      ).not.toContain("file_name()");
    }
  });

  it("routes every Rust store variant to a frontend handler", () => {
    const change = read("change.rs");
    const enumBody = change.slice(change.indexOf("pub enum Store"));
    const variants = [...enumBody.slice(0, enumBody.indexOf("}")).matchAll(/^\s{4}(\w+),/gm)].map(
      (m) => m[1],
    );
    expect(variants.length).toBeGreaterThan(0);

    const frontend = readFileSync(join(__dirname, "stores.ts"), "utf8");
    expect(frontend).toContain("registerStore");

    for (const variant of variants) {
      const store = STORES.find((s) => s.variant === variant);
      expect(store, `change.rs has ${variant} but storeChangeGuard has no entry for it`).toBeTruthy();
      // Each store registers in its OWN module — read that file rather than a
      // hardcoded one, or adding the second store fails a rule it satisfies.
      const own = readFileSync(join(__dirname, store!.frontend_module), "utf8");
      expect(
        own.includes(`registerStore("${store!.id}"`),
        `Store::${variant} emits "store:change" but ${store!.frontend_module} does not route "${store!.id}" — ` +
          `the event would land nowhere, which looks exactly like the bug this channel closes`,
      ).toBe(true);
    }
  });

  it("arms every store's subscription at module scope, not on mount", () => {
    // A subscription armed by a component's mount effect does not exist until
    // that component has been rendered — and side panes are not mounted until
    // their tab has been selected once. That is how research writes reached no
    // surface at all until the user happened to click Research.
    for (const store of STORES) {
      const own = readFileSync(join(__dirname, store.frontend_module), "utf8");
      const armedAtModuleScope = /^(watchStore\(\);|registerStore\()/m.test(own);
      expect(
        armedAtModuleScope,
        `${store.frontend_module} registers "${store.id}" but never arms it at module scope, ` +
          `so a surface that has not been opened yet hears nothing`,
      ).toBe(true);
    }
  });

  it("never pulses from a function the read path can reach", () => {
    // A pulse inside a read is a loop: change -> refetch -> read -> change.
    // It paces itself on the settle window and never stops.
    for (const store of STORES) {
      const src = stripComments(read(store.file));
      for (const m of src.matchAll(/(^|\s)fn\s+(\w+)\s*[(<]/gm)) {
        const name = m[2];
        if (!store.read_verbs.some((v) => name.includes(v))) continue;
        const body = fnBody(src, name) ?? "";
        expect(
          body.includes("change::pulse"),
          `${store.file}: ${name} looks like a read but pulses — that is a refetch loop`,
        ).toBe(false);
      }
    }
  });
});
