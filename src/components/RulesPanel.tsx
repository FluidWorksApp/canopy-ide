// The Rules panel: rules written in plain words, compiled by the brain into
// gates the workspace enforces, and approved by a person before they bite.
//
// "If a rule matters, the workspace enforces it. If it can't be enforced, it is
// a suggestion and labelled as one." Every rule here wears exactly one badge
// that says which — Enforced, Needs your approval, Suggestion only, Guidance —
// and the compiled gate is always shown as a sentence about what will be
// stopped, never as JSON.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "../ipc";
import type { Notify } from "../types";
import {
  BUILT_IN_CLASSES,
  OPT_IN_CLASSES,
  normalizeGate,
  plainLanguage,
  type ConfirmClass,
  type Gate,
  type RuleSuggestion,
} from "../gates/dsl";
import { compileRule, removeLines, suggestRules } from "../gates/compile";
import {
  blockCounts,
  builtInStops,
  deleteRule,
  loadRules,
  publishPolicy,
  ruleState,
  saveRule,
  setTrifecta,
  type Rule,
  type RuleScope,
  type RuleSet,
  type RuleTag,
} from "../gates/rules";
import { subscribeLedger } from "../ledger";
import { Button, Segmented } from "./ui";
import "./gates.css";

interface Props {
  roots: string[];
  /** The project's instruction files, from the scan InstructionsView already ran. */
  files: ipc.InstructionFile[] | null;
  onNotice: Notify;
  /** Scroll to and highlight one rule (from a blocked card's "Edit rule"). */
  focusRuleId?: string;
}

const BADGE: Record<ReturnType<typeof ruleState>, { label: string; cls: string; title: string }> = {
  enforced: { label: "Enforced", cls: "gate-badge-enforced", title: "Canopy checks this before an agent's action runs and blocks it." },
  "needs-approval": { label: "Needs your approval", cls: "gate-badge-pending", title: "Compiled, but not enforced until you approve the gate below." },
  "needs-compile": { label: "Not compiled", cls: "gate-badge-pending", title: "Compile it to see whether Canopy can enforce it." },
  suggestion: { label: "Suggestion only", cls: "gate-badge-suggestion", title: "No mechanical check can enforce this, so agents are told it as guidance." },
  guidance: { label: "Guidance", cls: "gate-badge-guidance", title: "Passed to agents as a reminder at the start of each session; not enforced." },
};

/** The editable values of a gate, one per line. */
function gateValues(g: Gate): string[] {
  switch (g.type) {
    case "deny-path-write":
    case "protect-tests":
      return g.globs;
    case "deny-command":
      return g.patterns;
    case "require-confirm":
      return g.patterns ?? [];
    case "package-allowlist":
    case "package-denylist":
      return g.names;
    case "egress-allowlist":
      return g.hosts;
    case "unenforceable":
      return [];
  }
}

function withValues(g: Gate, values: string[], cls?: ConfirmClass | ""): Gate | null {
  switch (g.type) {
    case "deny-path-write":
    case "protect-tests":
      return normalizeGate({ type: g.type, globs: values });
    case "deny-command":
      return normalizeGate({ type: g.type, patterns: values });
    case "require-confirm":
      return normalizeGate({ type: g.type, match: cls || undefined, patterns: values });
    case "package-allowlist":
    case "package-denylist":
      return normalizeGate({ type: g.type, names: values });
    case "egress-allowlist":
      return normalizeGate({ type: g.type, hosts: values });
    case "unenforceable":
      return g;
  }
}

const VALUE_LABEL: Partial<Record<Gate["type"], string>> = {
  "deny-path-write": "Protected paths (one per line)",
  "protect-tests": "Test paths (one per line; empty = the usual places)",
  "deny-command": "Blocked command patterns (one per line)",
  "require-confirm": "Also ask for commands matching (one per line)",
  "package-allowlist": "Allowed packages (one per line)",
  "package-denylist": "Banned packages (one per line)",
  "egress-allowlist": "Allowed hosts (one per line)",
};

export function RulesPanel({ roots, files, onNotice, focusRuleId }: Props) {
  const [root, setRoot] = useState(roots[0] ?? "");
  useEffect(() => {
    if (!roots.includes(root)) setRoot(roots[0] ?? "");
  }, [roots, root]);

  const [set, setSet] = useState<RuleSet | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftTag, setDraftTag] = useState<RuleTag>("enforced");
  const [draftScope, setDraftScope] = useState<RuleScope>("project");
  /** Rule id → compiling / the last compile failure. */
  const [compiling, setCompiling] = useState<Record<string, boolean>>({});
  const [compileError, setCompileError] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!root) return null;
    try {
      const next = await loadRules(root);
      setSet(next);
      setLoadError(null);
      return next;
    } catch (e) {
      setLoadError(String(e));
      return null;
    }
  }, [root]);

  // Re-read when anything lands in this repo's ledger — a block from a hook,
  // a rule saved in another window.
  useEffect(() => {
    void reload();
    if (!root) return;
    let timer: number | undefined;
    const off = subscribeLedger(root, (e) => {
      if (e.kind !== "rule") return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void reload(), 300);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [root, reload]);

  // Keep the hook's file in step with the ledger. On open too: a policy file
  // deleted by hand, or a Linux workspace that was never sent this project's
  // rules, gets them back the first time someone looks.
  const published = useRef<string>("");
  useEffect(() => {
    if (!set || !root) return;
    const key = JSON.stringify([root, set.rules.map((r) => [r.id, r.data.approved, r.data.tag]), set.trifecta]);
    if (published.current === key) return;
    published.current = key;
    void publishPolicy(root, set).catch((e) => onNotice(`Couldn't update the rules agents are checked against: ${e}`, "error"));
  }, [set, root, onNotice]);

  const counts = useMemo(() => (set ? blockCounts(set) : new Map<string, number>()), [set]);

  const compile = async (rule: Rule) => {
    setCompiling((c) => ({ ...c, [rule.id]: true }));
    setCompileError((c) => ({ ...c, [rule.id]: "" }));
    const top = files?.filter((f) => f.root === root).map((f) => f.label) ?? [];
    const result = await compileRule(rule.data.text, root, { files: top });
    setCompiling((c) => ({ ...c, [rule.id]: false }));
    if (!result.ok) {
      setCompileError((c) => ({ ...c, [rule.id]: result.message }));
      return;
    }
    await saveRule(root, rule, { gate: result.value.gate, explanation: result.value.explanation, approved: false });
    await reload();
  };

  const add = async () => {
    const text = draft.trim();
    if (!text || !root) return;
    try {
      const saved = await saveRule(root, null, { text, tag: draftTag, scope: draftScope });
      setDraft("");
      await reload();
      if (draftTag === "enforced") void compile(saved);
    } catch (e) {
      onNotice(`Couldn't save the rule: ${e}`, "error");
    }
  };

  const update = async (rule: Rule, patch: Parameters<typeof saveRule>[2]) => {
    try {
      await saveRule(root, rule, patch);
      await reload();
    } catch (e) {
      onNotice(`Couldn't save the rule: ${e}`, "error");
    }
  };

  const remove = async (rule: Rule) => {
    await deleteRule(root, rule).catch((e) => onNotice(`Couldn't delete the rule: ${e}`, "error"));
    await reload();
  };

  const focusRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    focusRef.current?.scrollIntoView?.({ block: "center" });
  }, [focusRuleId, set]);

  const builtIns = set ? builtInStops(set.blocks) : 0;

  return (
    <div className="gates-panel">
      <div className="gates-head">
        <h2>Rules</h2>
        <p className="gates-lede">
          Write rules in plain words. <strong>Enforced</strong> rules are compiled into checks Canopy runs before an
          agent's action — a rule that matters is a refusal, not a request. <strong>Guidance</strong> is passed to agents
          as a short reminder. A rule no check can enforce is labelled <em>suggestion only</em>.
        </p>
        {roots.length > 1 && (
          <label className="gates-root">
            Repository{" "}
            <select value={root} onChange={(e) => setRoot(e.target.value)} aria-label="Repository">
              {roots.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {loadError && <div className="gates-error">Couldn't read this project's rules: {loadError}</div>}

      <form
        className="gates-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label htmlFor="gates-new-rule" className="gates-label">
          New rule
        </label>
        <textarea
          id="gates-new-rule"
          value={draft}
          rows={2}
          placeholder="e.g. Never touch the migrations folder · Don't install moment · Ask before publishing to npm"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void add();
          }}
        />
        <div className="gates-add-row">
          <Segmented
            aria-label="Rule type"
            options={[
              { id: "enforced", label: "Enforced" },
              { id: "guidance", label: "Guidance" },
            ]}
            value={draftTag}
            onChange={setDraftTag}
          />
          <Segmented
            aria-label="Who it applies to"
            options={[
              { id: "project", label: "This project" },
              { id: "team", label: "Team" },
            ]}
            value={draftScope}
            onChange={setDraftScope}
          />
          <Button type="submit" variant="accent" disabled={!draft.trim()}>
            {draftTag === "enforced" ? "Add and compile" : "Add rule"}
          </Button>
        </div>
      </form>

      <ul className="gates-list" aria-label="Rules">
        {set && set.rules.length === 0 && (
          <li className="gates-empty">No rules yet. The built-in protections below are on regardless.</li>
        )}
        {set?.rules.map((rule) => {
          const state = ruleState(rule);
          const badge = BADGE[state];
          const n = counts.get(rule.id) ?? 0;
          const focused = rule.id === focusRuleId;
          return (
            <li
              key={rule.id}
              ref={focused ? focusRef : undefined}
              className={`gates-rule ${focused ? "gates-rule-focus" : ""}`}
            >
              <div className="gates-rule-head">
                <span className="gates-rule-text">{rule.data.text}</span>
                <span className={`gate-badge ${badge.cls}`} title={badge.title}>
                  {badge.label}
                </span>
                <span className="gate-chip">{rule.scope === "team" ? "Team" : "Project"}</span>
                {n > 0 && (
                  <span className="gate-chip gate-chip-count" title="Times this rule stopped an agent">
                    Blocked {n}×
                  </span>
                )}
              </div>
              {rule.data.gate && (
                <div className="gates-rule-gate">
                  <span className="gates-rule-plain">{plainLanguage(rule.data.gate)}</span>
                  {rule.data.origin && <span className="gates-rule-origin">From {rule.data.origin}</span>}
                </div>
              )}
              {compileError[rule.id] && <div className="gates-error">{compileError[rule.id]}</div>}
              {editing === rule.id && (
                <RuleEditor
                  rule={rule}
                  onCancel={() => setEditing(null)}
                  onSave={async (patch) => {
                    await update(rule, patch);
                    setEditing(null);
                  }}
                />
              )}
              <div className="gates-rule-actions">
                {state === "needs-approval" && (
                  <Button size="sm" variant="accent" onClick={() => void update(rule, { approved: true })}>
                    Approve gate
                  </Button>
                )}
                {state === "enforced" && (
                  <Button size="sm" onClick={() => void update(rule, { approved: false })}>
                    Pause
                  </Button>
                )}
                {rule.data.tag === "enforced" && (
                  <Button size="sm" disabled={!!compiling[rule.id]} onClick={() => void compile(rule)}>
                    {compiling[rule.id] ? "Compiling…" : rule.data.gate ? "Recompile" : "Compile"}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setEditing(editing === rule.id ? null : rule.id)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void update(rule, { tag: rule.data.tag === "enforced" ? "guidance" : "enforced" })}
                >
                  {rule.data.tag === "enforced" ? "Make guidance" : "Make enforced"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void remove(rule)}>
                  Delete
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <section className="gates-section" aria-labelledby="gates-builtin">
        <h3 id="gates-builtin">Always on: actions that can't be undone</h3>
        <p>
          Dropping database data, deleting folders outside the project, force-pushing a protected branch, throwing away
          uncommitted work, deleting volumes or buckets, tearing down infrastructure, production deploys and moving money
          stop and ask you first. Approving lets that exact command run once, within 10 minutes.
          {builtIns > 0 && <> Stopped {builtIns}× so far.</>}
        </p>
      </section>

      <section className="gates-section" aria-labelledby="gates-trifecta">
        <h3 id="gates-trifecta">After a session reads web content</h3>
        <p>
          Pages and search results can carry instructions that aren't yours. Once an agent session has fetched web
          content, Canopy can keep secrets (.env files, saved passwords) and outbound writes (pushes, POSTs, GitHub
          writes) away from it for the rest of that session.
        </p>
        <Segmented
          aria-label="After a session reads web content"
          options={[
            { id: "warn", label: "Warn only" },
            { id: "block", label: "Block secrets and outbound writes" },
          ]}
          value={set?.trifecta ?? "warn"}
          onChange={(mode) => {
            void setTrifecta(root, mode)
              .then(() => reload())
              .catch((e) => onNotice(`Couldn't save that: ${e}`, "error"));
          }}
        />
      </section>

      <InstructionSuggestions root={root} roots={roots} files={files} onNotice={onNotice} onAdded={() => void reload()} />

      <p className="gates-coverage">
        Enforced in Claude Code sessions (on this computer and in cloud workspaces) and Antigravity. Other agent CLIs
        get guidance only: their hooks can't refuse a tool call yet. Egress and shell-path checks are best effort — they
        read the command line, not everything a program might do.
      </p>
    </div>
  );
}

function RuleEditor({
  rule,
  onSave,
  onCancel,
}: {
  rule: Rule;
  onSave: (patch: { text: string; scope: RuleScope; gate?: Gate | null }) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(rule.data.text);
  const [scope, setScope] = useState<RuleScope>(rule.scope === "team" ? "team" : "project");
  const gate = rule.data.gate;
  const [values, setValues] = useState((gate ? gateValues(gate) : []).join("\n"));
  const [cls, setCls] = useState<ConfirmClass | "">(gate?.type === "require-confirm" ? gate.match ?? "" : "");
  const [error, setError] = useState<string | null>(null);
  const editable = gate && gate.type !== "unenforceable";

  const save = async () => {
    let next: Gate | null | undefined = undefined;
    if (editable && gate) {
      next = withValues(
        gate,
        values.split("\n").map((v) => v.trim()).filter(Boolean),
        cls,
      );
      if (!next) {
        setError("That gate isn't one Canopy can enforce — check the values (no “**” globs, no lookahead in patterns).");
        return;
      }
    }
    // A reworded rule's old gate no longer speaks for it.
    if (text.trim() !== rule.data.text && next === undefined) next = null;
    await onSave({ text: text.trim(), scope, ...(next !== undefined ? { gate: next } : {}) });
  };

  return (
    <div className="gates-editor">
      <label className="gates-label">
        Rule
        <textarea value={text} rows={2} onChange={(e) => setText(e.target.value)} />
      </label>
      <Segmented
        aria-label="Who it applies to"
        options={[
          { id: "project", label: "This project" },
          { id: "team", label: "Team" },
        ]}
        value={scope}
        onChange={setScope}
      />
      {editable && gate && (
        <>
          {gate.type === "require-confirm" && (
            <label className="gates-label">
              Ask before
              <select value={cls} onChange={(e) => setCls(e.target.value as ConfirmClass | "")}>
                <option value="">(only the patterns below)</option>
                {[...OPT_IN_CLASSES, ...BUILT_IN_CLASSES].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="gates-label">
            {VALUE_LABEL[gate.type] ?? "Values"}
            <textarea value={values} rows={3} onChange={(e) => setValues(e.target.value)} />
          </label>
          <p className="gates-hint">Changing the gate means approving it again.</p>
        </>
      )}
      {error && <div className="gates-error">{error}</div>}
      <div className="gates-rule-actions">
        <Button size="sm" variant="accent" disabled={!text.trim()} onClick={() => void save()}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** "Suggest which lines should become enforced gates": the brain reads one of
 *  the project's instruction files and proposes rules; accepting one adds it
 *  (already compiled, awaiting approval) and can take the line out of the file. */
function InstructionSuggestions({
  root,
  roots,
  files,
  onNotice,
  onAdded,
}: {
  root: string;
  roots: string[];
  files: ipc.InstructionFile[] | null;
  onNotice: Notify;
  onAdded: () => void;
}) {
  const candidates = useMemo(
    () =>
      (files ?? []).filter(
        (f) => f.exists && f.scope === "project" && (f.kind === "instructions" || f.kind === "rule"),
      ),
    [files],
  );
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<RuleSuggestion[] | null>(null);
  const [removeLine, setRemoveLine] = useState(true);
  const [accepted, setAccepted] = useState<string[]>([]);

  const suggest = async (f: ipc.InstructionFile) => {
    setOpen(f.path);
    setBusy(true);
    setError(null);
    setSuggestions(null);
    setAccepted([]);
    try {
      const text = await ipc.instructionsRead(f.path, roots);
      const result = await suggestRules(f.label, text, f.root || root);
      if (!result.ok) setError(result.message);
      else setSuggestions(result.value);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const accept = async (f: ipc.InstructionFile, s: RuleSuggestion) => {
    try {
      await saveRule(root, null, {
        text: s.rule,
        tag: "enforced",
        gate: s.gate,
        explanation: s.why,
        approved: false,
        origin: f.label,
      });
      if (removeLine) {
        const text = await ipc.instructionsRead(f.path, roots);
        const next = removeLines(text, [s.line]);
        if (next !== text) await ipc.instructionsWrite(f.path, roots, next);
      }
      setAccepted((a) => [...a, s.line]);
      onAdded();
      onNotice(`Added “${s.rule}” — approve its gate to enforce it.`, "success");
    } catch (e) {
      onNotice(`Couldn't add the rule: ${e}`, "error");
    }
  };

  return (
    <section className="gates-section" aria-labelledby="gates-shrink">
      <h3 id="gates-shrink">Instruction files</h3>
      <p>
        Long instruction files are followed unreliably. Ask the brain which lines are really hard rules — those can
        become enforced gates, and come out of the file.
      </p>
      {candidates.length === 0 && <p className="gates-hint">This project has no instruction files.</p>}
      <ul className="gates-files">
        {candidates.map((f) => (
          <li key={f.path}>
            <span className="gates-file-label">{f.label}</span>
            <Button size="sm" disabled={busy && open === f.path} onClick={() => void suggest(f)}>
              {busy && open === f.path ? "Reading…" : "Suggest which lines should become enforced gates"}
            </Button>
            {open === f.path && error && <div className="gates-error">{error}</div>}
            {open === f.path && suggestions && (
              <div className="gates-suggestions">
                {suggestions.length === 0 ? (
                  <p className="gates-hint">Nothing in this file needs to be a gate — it's guidance.</p>
                ) : (
                  <>
                    <label className="gates-check">
                      <input type="checkbox" checked={removeLine} onChange={(e) => setRemoveLine(e.target.checked)} />
                      Remove the line from {f.label} when I add the rule
                    </label>
                    <ul>
                      {suggestions.map((s) => (
                        <li key={s.line} className="gates-suggestion">
                          <blockquote>{s.line}</blockquote>
                          <div className="gates-rule-text">{s.rule}</div>
                          <div className="gates-rule-plain">{plainLanguage(s.gate)}</div>
                          {s.why && <div className="gates-hint">{s.why}</div>}
                          <Button
                            size="sm"
                            variant="accent"
                            disabled={accepted.includes(s.line)}
                            onClick={() => void accept(f, s)}
                          >
                            {accepted.includes(s.line) ? "Added" : "Add as rule"}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
