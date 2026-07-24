// The in-app browser: an iframe onto the preview proxy (see preview.rs), a URL
// bar, and an annotate mode. In annotate mode the injected picker highlights
// elements in the live page; each click lands here as an annotation the user
// comments on, and the collected feedback goes to an agent through the same
// AgentLaunchButton + PTY-seed path tickets and PRs use.
import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
import {
  previewFeedbackContext,
  serverForUrl,
  type PreviewAnnotation,
  type PreviewServer,
} from "../preview";
import { registerBrowserTarget } from "../previewAgent";
import { AgentLaunchButton } from "./AgentLaunchButton";
import { LiveDot } from "./icons";
import type { AgentTarget } from "./TicketsPanel";

interface PreviewViewProps {
  /** The owning SubTab's id — how agent browser ops address this view. */
  tabId: string;
  url: string;
  annotations: PreviewAnnotation[];
  /** Persist navigation / annotation changes onto the tab, so they survive a
   *  switch away and back (the view itself unmounts like every doc tab). */
  onPatch: (patch: { url?: string; annotations?: PreviewAnnotation[] }) => void;
  /** Servers detected listening in this project's terminals, each tied to its
   *  component — what the empty tab offers, and what links a URL to a codebase. */
  servers: PreviewServer[];
  agentTargets: AgentTarget[];
  installed: Record<string, boolean>;
  onSendToAgent: (target: AgentTarget, text: string) => void;
  /** `cwd` is the serving component's directory when the URL is linked to one. */
  onStartNew: (agentId: string, text: string, cwd: string | null) => void;
  onNotice: (msg: string) => void;
}

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/** Everything after the origin — path + query + hash. */
const restOf = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}` || "/";
  } catch {
    return "/";
  }
};

const normalize = (raw: string): string | null => {
  const t = raw.trim();
  if (!t) return null;
  const withScheme = /^[a-z]+:\/\//i.test(t) ? t : `http://${t}`;
  return originOf(withScheme) ? withScheme : null;
};

export function PreviewView({
  tabId,
  url,
  annotations,
  onPatch,
  servers,
  agentTargets,
  installed,
  onSendToAgent,
  onStartNew,
  onNotice,
}: PreviewViewProps) {
  const [proxy, setProxy] = useState<ipc.PreviewInfo | null>(null);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [draft, setDraft] = useState(url);
  const [picking, setPicking] = useState(false);
  const [proxyError, setProxyError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const draftFocused = useRef(false);

  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const proxyRef = useRef(proxy);
  proxyRef.current = proxy;
  const urlRef = useRef(url);
  urlRef.current = url;
  const pickingRef = useRef(picking);
  pickingRef.current = picking;

  const origin = originOf(url);

  const post = useCallback((msg: object) => {
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  // One proxy per origin; (re)acquired when the tab's origin changes. The
  // proxy is shared and cheap, so it's left running on unmount — the tab may
  // come right back, and app exit sweeps them all.
  useEffect(() => {
    if (!origin) return;
    let stale = false;
    setProxyError(null);
    ipc
      .previewStart(origin)
      .then((p) => {
        if (stale) return;
        setProxy(p);
        setFrameSrc(`http://127.0.0.1:${p.port}${restOf(urlRef.current)}`);
      })
      .catch((err) => {
        if (!stale) setProxyError(String(err));
      });
    return () => {
      stale = true;
    };
  }, [origin]);

  /** The previewed page's real URL for a proxied one the iframe reports. */
  const unproxied = useCallback((proxiedUrl: string): string | null => {
    const p = proxyRef.current;
    if (!p) return null;
    try {
      const u = new URL(proxiedUrl);
      if (u.host !== `127.0.0.1:${p.port}`) return null;
      return `${p.origin}${u.pathname}${u.search}${u.hash}`;
    } catch {
      return null;
    }
  }, []);

  // ---------- agent browser control ----------
  // Ops arrive from the MCP bridge via ProjectView (see previewAgent.ts) and
  // are answered through ipc.browserResult, which releases the agent's held
  // HTTP request. In-page ops go into the iframe as {canopy:"agent"} messages;
  // the injected picker answers with {canopy:"agent-result"}. A page that's
  // still loading swallows postMessages, so unanswered ops are re-posted when
  // the (new) document announces ready.
  const pendingOps = useRef(new Map<number, { op: ipc.AgentBrowserOp; timer: number }>());
  const navWaiters = useRef<{ id: number; timer: number }[]>([]);

  const postAgentOp = useCallback(
    (op: ipc.AgentBrowserOp) => {
      post({
        canopy: "agent",
        id: op.id,
        op: op.op,
        ref: op.ref ?? undefined,
        selector: op.selector ?? undefined,
        text: op.text ?? undefined,
        submit: op.submit ?? undefined,
        append: op.append ?? undefined,
        code: op.code ?? undefined,
        lines: op.lines ?? undefined,
        clear: op.clear ?? undefined,
        max: op.max ?? undefined,
      });
    },
    [post],
  );

  // The picker inside the page talks postMessage; accept only messages from
  // our own iframe's window.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data;
      if (!d || typeof d !== "object" || !("canopy" in d)) return;
      if (d.canopy === "ready") {
        // Fresh document (first load or in-page navigation): restore mode and
        // the badges for annotations the tab still holds.
        post({ canopy: "mode", on: pickingRef.current });
        post({
          canopy: "sync",
          marks: annotationsRef.current.map((a) => ({ n: a.n, selector: a.selector })),
        });
        // A new document dropped any in-flight agent ops with it.
        for (const p of pendingOps.current.values()) postAgentOp(p.op);
      }
      if (d.canopy === "ready" || d.canopy === "nav") {
        const real = typeof d.url === "string" ? unproxied(d.url) : null;
        if (real && real !== urlRef.current) {
          onPatch({ url: real });
          if (!draftFocused.current) setDraft(real);
        }
        const arrived = navWaiters.current;
        navWaiters.current = [];
        for (const w of arrived) {
          clearTimeout(w.timer);
          void ipc.browserResult(w.id, true, {
            url: real ?? urlRef.current,
            title: typeof d.title === "string" ? d.title : "",
          });
        }
      } else if (d.canopy === "agent-result") {
        const p = pendingOps.current.get(d.id);
        if (p) {
          clearTimeout(p.timer);
          pendingOps.current.delete(d.id);
          void ipc.browserResult(d.id, !!d.ok, d.data);
        }
      } else if (d.canopy === "annotation" && d.payload) {
        const next: PreviewAnnotation = {
          ...(d.payload as Omit<PreviewAnnotation, "comment" | "n">),
          pageUrl: unproxied(d.payload.pageUrl) ?? urlRef.current,
          n: annotationsRef.current.length + 1,
          comment: "",
        };
        onPatch({ annotations: [...annotationsRef.current, next] });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onPatch, post, postAgentOp, unproxied]);

  const navigate = useCallback(
    (raw: string) => {
      const target = normalize(raw);
      if (!target) {
        onNotice(`Not a URL: ${raw}`);
        return;
      }
      setDraft(target);
      onPatch({ url: target });
      const p = proxyRef.current;
      if (p && p.origin === originOf(target)) {
        setFrameSrc(`http://127.0.0.1:${p.port}${restOf(target)}`);
      }
      // A different origin re-runs the proxy effect via the `origin` dep.
    },
    [onNotice, onPatch],
  );

  // Receive agent ops for this tab; answer everything on unmount so a held
  // bridge request never waits out its timeout for an answer that can no
  // longer come.
  useEffect(() => {
    const run = (op: ipc.AgentBrowserOp) => {
      if (op.op === "navigate") {
        if (op.url) navigate(op.url);
        else
          post({
            canopy: "navigate",
            delta: op.action === "back" ? -1 : op.action === "forward" ? 1 : 0,
          });
        // Answered when the page announces itself (ready/nav above); if it
        // never does, answer with what we know rather than failing — the
        // navigation itself was issued.
        const timer = window.setTimeout(() => {
          navWaiters.current = navWaiters.current.filter((w) => w.id !== op.id);
          void ipc.browserResult(op.id, true, {
            url: urlRef.current,
            note: "Navigation was issued but the page hasn't finished loading — call canopy_browser_snapshot to check on it.",
          });
        }, 10000);
        navWaiters.current.push({ id: op.id, timer });
        return;
      }
      const timer = window.setTimeout(() => {
        pendingOps.current.delete(op.id);
        void ipc.browserResult(
          op.id,
          false,
          "The page didn't answer — it may still be loading, or stuck. Try canopy_browser_navigate (reload) or check the server with canopy_server_output.",
        );
      }, 12000);
      pendingOps.current.set(op.id, { op, timer });
      postAgentOp(op);
    };
    const unregister = registerBrowserTarget(tabId, run);
    return () => {
      unregister();
      for (const [id, p] of pendingOps.current) {
        clearTimeout(p.timer);
        void ipc.browserResult(id, false, "The preview tab closed while this operation ran.");
      }
      pendingOps.current.clear();
      for (const w of navWaiters.current) {
        clearTimeout(w.timer);
        void ipc.browserResult(w.id, true, { url: urlRef.current });
      }
      navWaiters.current = [];
    };
  }, [tabId, navigate, post, postAgentOp]);

  const togglePicking = () => {
    const on = !picking;
    setPicking(on);
    post({ canopy: "mode", on });
  };

  const setComment = (n: number, comment: string) => {
    onPatch({
      annotations: annotationsRef.current.map((a) => (a.n === n ? { ...a, comment } : a)),
    });
  };

  const removeAnnotation = (n: number) => {
    const renumbered = annotationsRef.current
      .filter((a) => a.n !== n)
      .map((a, i) => ({ ...a, n: i + 1 }));
    onPatch({ annotations: renumbered });
    post({ canopy: "sync", marks: renumbered.map((a) => ({ n: a.n, selector: a.selector })) });
  };

  const clearAnnotations = () => {
    onPatch({ annotations: [] });
    post({ canopy: "sync", marks: [] });
  };

  /** The codebase behind whatever page is currently shown — re-derived on
   *  every navigation, so crossing to another server's port relinks. */
  const linked = serverForUrl(url, servers);

  const feedback = () =>
    previewFeedbackContext(
      urlRef.current,
      annotationsRef.current,
      serverForUrl(urlRef.current, servers),
    );

  // ---------- empty tab: pick one of the project's own servers ----------
  // No manual URL entry on purpose: the preview only opens servers Canopy can
  // trace back to a component, so every annotation knows which codebase to
  // change. A URL typed by hand would be an untethered page with no component
  // link — exactly what this feature exists to avoid.
  if (!origin) {
    return (
      <div className="preview-empty">
        <h2>Preview a running server</h2>
        <p className="preview-empty-hint">
          Open one of this project's servers in an embedded browser, then mark elements and send
          the feedback to an agent working in the right component.
        </p>
        {servers.length > 0 ? (
          <div className="preview-server-list">
            {servers.map((s) => (
              <button
                key={`${s.ptyId}:${s.port}`}
                className="preview-server"
                title={`${s.command ?? "shell"} — ${s.cwd}`}
                onClick={() => navigate(s.url)}
              >
                <LiveDot size={7} className="preview-server-dot" />
                <span className="preview-server-title">{s.title}</span>
                <span className="preview-server-url">localhost:{s.port}</span>
                {s.componentLabel && (
                  <span className="preview-component-badge">{s.componentLabel}</span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <div className="preview-setup">
            <p className="preview-setup-lead">No servers are running in this project yet.</p>
            <p className="preview-setup-note">
              The preview lists the dev servers Canopy detects in your project's terminals, each
              linked to the component it runs in — that link is what tells an agent which codebase
              your feedback is about. To get one here:
            </p>
            <ol className="preview-setup-steps">
              <li>
                Add a run command to a component in <strong>project settings</strong> (each
                component has a “Run commands” list — for example a <code>dev</code> command like{" "}
                <code>npm run dev</code>).
              </li>
              <li>
                Start it — from the component's <strong>▶</strong> in the Components panel, or the{" "}
                <strong>＋ ▾</strong> launcher. It runs in the <strong>RUNS</strong> rail.
              </li>
              <li>
                Once it's listening, its <code>localhost</code> address appears here, tagged with
                its component. Pick it to start previewing.
              </li>
            </ol>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="preview-view">
      <div className="preview-toolbar">
        <button className="btn-icon" title="Back" onClick={() => post({ canopy: "navigate", delta: -1 })}>
          ‹
        </button>
        <button className="btn-icon" title="Forward" onClick={() => post({ canopy: "navigate", delta: 1 })}>
          ›
        </button>
        <button className="btn-icon" title="Reload" onClick={() => post({ canopy: "navigate", delta: 0 })}>
          ↻
        </button>
        <form
          className="preview-url-form"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(draft);
            (e.currentTarget.firstElementChild as HTMLInputElement | null)?.blur();
          }}
        >
          <input
            className="preview-url-input"
            value={draft}
            spellCheck={false}
            onFocus={() => (draftFocused.current = true)}
            onBlur={() => {
              draftFocused.current = false;
              setDraft(urlRef.current);
            }}
            onChange={(e) => setDraft(e.target.value)}
          />
        </form>
        {linked && (
          <span
            className="preview-component-badge"
            title={`Served by "${linked.title}"${linked.command ? ` (${linked.command})` : ""} — ${
              linked.componentPath
            }\nFeedback from this page goes to an agent in this component.`}
          >
            {linked.componentLabel ?? linked.title}
          </span>
        )}
        <button
          className={`btn-mini preview-annotate-toggle ${picking ? "preview-annotate-on" : ""}`}
          title="Annotate: click any element on the page to attach feedback to it"
          onClick={togglePicking}
        >
          ◎ Annotate{annotations.length > 0 ? ` (${annotations.length})` : ""}
        </button>
      </div>
      <div className="preview-body">
        <div className="preview-frame-wrap">
          {proxyError ? (
            <div className="preview-error">
              <p>Couldn't reach {origin}.</p>
              <pre>{proxyError}</pre>
              <button className="btn" onClick={() => navigate(urlRef.current)}>
                Retry
              </button>
            </div>
          ) : (
            frameSrc && (
              <iframe
                ref={iframeRef}
                className="preview-frame"
                src={frameSrc}
                title="preview"
              />
            )
          )}
        </div>
        {(annotations.length > 0 || picking) && (
          <div className="preview-panel">
            <div className="preview-panel-head">
              <span>Feedback</span>
              {annotations.length > 0 && (
                <button className="btn-mini" onClick={clearAnnotations}>
                  Clear all
                </button>
              )}
            </div>
            {annotations.length === 0 && (
              <p className="preview-panel-hint">
                Click an element on the page to tag it, then write what should change.
              </p>
            )}
            <div className="preview-panel-list">
              {annotations.map((a) => (
                <div className="preview-note" key={a.n}>
                  <div className="preview-note-head">
                    <span className="preview-note-badge">{a.n}</span>
                    <span className="preview-note-what" title={a.selector}>
                      {a.components[0] ? `⟨${a.components[0]}⟩ ` : ""}
                      {`<${a.tag}${a.id ? `#${a.id}` : ""}>`}
                    </span>
                    <button
                      className="btn-icon preview-note-remove"
                      title="Remove"
                      onClick={() => removeAnnotation(a.n)}
                    >
                      ✕
                    </button>
                  </div>
                  {a.text && <div className="preview-note-text">“{a.text.slice(0, 120)}”</div>}
                  <textarea
                    className="preview-note-comment"
                    placeholder="What should change here?"
                    value={a.comment}
                    onChange={(e) => setComment(a.n, e.target.value)}
                  />
                </div>
              ))}
            </div>
            {annotations.length > 0 && (
              <div className="preview-panel-foot">
                <AgentLaunchButton
                  label="Send feedback"
                  agentTargets={agentTargets}
                  installed={installed}
                  newAgentLabel={
                    linked?.componentLabel
                      ? `New agent in ${linked.componentLabel}`
                      : "New agent on this feedback"
                  }
                  primaryTitle={(cli) =>
                    `Start ${cli} on this feedback${
                      linked?.componentLabel ? ` in the ${linked.componentLabel} component` : ""
                    }`
                  }
                  onStart={(agentId) =>
                    onStartNew(agentId, feedback(), linked?.componentPath ?? null)
                  }
                  onSend={(target) => onSendToAgent(target, feedback())}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
