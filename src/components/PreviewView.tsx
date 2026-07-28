// The in-app browser: a page, a URL bar, and an annotate mode. In annotate mode
// the injected picker highlights elements in the live page; each click lands
// here as an annotation the user comments on, and the collected feedback goes
// to an agent through the same AgentLaunchButton + PTY-seed path tickets and
// PRs use.
//
// Two engines sit behind the same toolbar (see browserBounds.chooseEngine):
//
//   webview — a real child webview at the page's real origin, on a persistent
//             profile, so a site you log into stays logged in. It is a native
//             view drawn OVER the window, so this component renders only a
//             placeholder and hands its rect to browserHost, which is what
//             actually positions and hides it.
//   proxy   — the original: an iframe onto a per-origin loopback reverse proxy
//             (preview.rs). No sessions, but it is the only engine that exists
//             off macOS.
//
// Everything below the transport is shared. The same picker script runs in the
// page under both, and answers the same messages; only how those messages
// travel differs — postMessage through the iframe, or an evaluated call and a
// drained outbox through browser.rs.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  browserPageChanged,
  browserViewChanged,
  forgetBrowserView,
  refreshBrowserViews,
  registerBrowserView,
  setBrowserViewWanted,
  themeRgb,
  useBrowserEngine,
  useBrowserPane,
} from "../browserHost";
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

/** A trusted press landed inside a previewed page, forwarded out of it by the
 *  injected picker. The page's own events never reach this window under either
 *  engine, so this is the only way the rest of the app hears about them. */
export const BROWSER_INPUT_EVENT = "canopy:browser-input";

interface PreviewViewProps {
  /** The owning SubTab's id — how agent browser ops address this view. */
  tabId: string;
  url: string;
  annotations: PreviewAnnotation[];
  /** Whether this tab is the one in front of an open project. Under the proxy
   *  this only tunes the agent-cursor choreography; under the webview engine it
   *  is what puts the native view on screen at all. */
  visible: boolean;
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
  visible,
  onPatch,
  servers,
  agentTargets,
  installed,
  onSendToAgent,
  onStartNew,
  onNotice,
}: PreviewViewProps) {
  const engine = useBrowserEngine();
  const native = engine === "webview";
  // What the placeholder stands in with while the native view is out of the
  // way: a still of the page, or the app's own background — never a white hole.
  const pane = useBrowserPane(tabId, native);

  const [proxy, setProxy] = useState<ipc.PreviewInfo | null>(null);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [draft, setDraft] = useState(url);
  const [picking, setPicking] = useState(false);
  const [proxyError, setProxyError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const draftFocused = useRef(false);

  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const proxyRef = useRef(proxy);
  proxyRef.current = proxy;
  const urlRef = useRef(url);
  urlRef.current = url;
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // ProjectView hands down a fresh arrow every render, so an effect that
  // depends on it re-subscribes constantly — and a Tauri listener is registered
  // asynchronously, so each churn leaves a window with nothing listening. A
  // navigation event lost in one of those windows used to strand the freeze
  // frame forever; now nothing that matters depends on this identity.
  const onPatchRef = useRef(onPatch);
  onPatchRef.current = onPatch;
  const nativeRef = useRef(native);
  nativeRef.current = native;

  const origin = originOf(url);

  const post = useCallback((msg: Record<string, unknown>) => {
    if (nativeRef.current) void ipc.browserCommand(tabId, msg).catch(() => {});
    else iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, [tabId]);

  // ---------- proxy engine: one proxy per origin ----------
  // (Re)acquired when the tab's origin changes. The proxy is shared and cheap,
  // so it's left running on unmount — the tab may come right back, and app exit
  // sweeps them all.
  useEffect(() => {
    if (native || !origin) return;
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
  }, [native, origin]);

  // ---------- webview engine: the native view's lifecycle ----------
  // The placeholder's rect is measured by browserHost on demand rather than
  // pushed from here — a pane drag moves this div without re-rendering it.
  useEffect(() => {
    if (!native) return;
    registerBrowserView(tabId, () => hostRef.current);
    return () => {
      forgetBrowserView(tabId);
      void ipc.browserClose(tabId);
    };
  }, [native, tabId]);

  useEffect(() => {
    if (!native) return;
    setBrowserViewWanted(tabId, visible && !!url);
  }, [native, tabId, visible, url]);

  // The page is created the first time its tab is actually shown, not when the
  // tab opens: a session restored from hibernation can hold a dozen preview
  // tabs, and a dozen webviews loading at once is not a startup. The
  // placeholder often has no size on the render that reveals it, so the
  // observer — not the effect — is what finally triggers this.
  const opened = useRef(false);
  const ensureOpen = useRef<() => void>(() => {});
  ensureOpen.current = () => {
    if (!nativeRef.current || opened.current || !visibleRef.current || !urlRef.current) return;
    const r = hostRef.current?.getBoundingClientRect();
    if (!r || r.width < 2 || r.height < 2) return;
    const target = urlRef.current;
    opened.current = true;
    void ipc.browserOpen(tabId, target, r.x, r.y, r.width, r.height, themeRgb()).then(
      () => refreshBrowserViews(),
      (err) => {
        opened.current = false;
        onNotice(`Couldn't open ${target}: ${String(err)}`);
      },
    );
  };

  useEffect(() => {
    if (!native) {
      opened.current = false;
      return;
    }
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => ensureOpen.current());
    ro.observe(el);
    ensureOpen.current();
    return () => ro.disconnect();
  }, [native, tabId]);

  useEffect(() => {
    ensureOpen.current();
  }, [native, url, visible]);

  // ---------- agent browser control ----------
  // Ops arrive from the MCP bridge via ProjectView (see previewAgent.ts) and
  // are answered through ipc.browserResult, which releases the agent's held
  // HTTP request. In-page ops go to the picker as {canopy:"agent"} messages and
  // come back as {canopy:"agent-result"} — by postMessage under the proxy, by
  // an evaluated call and a drained outbox under the webview engine. A page
  // that's still loading swallows either, so unanswered ops are re-sent when
  // the (new) document announces ready.
  const pendingOps = useRef(new Map<number, { op: ipc.AgentBrowserOp; timer: number }>());
  const navWaiters = useRef<{ id: number; timer: number }[]>([]);

  /** Whether this preview is actually painted right now. Under the proxy a
   *  background tab stays laid out — that's what keeps snapshot and click
   *  honest — but it isn't on screen, so the page's cursor choreography is
   *  playing to nobody. Under the webview engine an unpainted view is genuinely
   *  hidden, and `visible` is the whole truth. */
  const painted = useCallback(() => {
    if (nativeRef.current) return visibleRef.current;
    return (
      iframeRef.current?.checkVisibility?.({
        visibilityProperty: true,
        opacityProperty: true,
      }) ?? true
    );
  }, []);

  // Where the keyboard was before an unwatched op ran. A click or a type ends
  // with the page focusing the element it acted on, and focus inside an iframe
  // is focus taken from whatever the user was typing in. Recorded before the op
  // and given back after it — only if the iframe really did take it. The
  // webview engine can't steal it: a hidden native view takes no focus.
  const focusBefore = useRef<HTMLElement | null>(null);

  const restoreFocus = useCallback(() => {
    const back = focusBefore.current;
    focusBefore.current = null;
    if (!back || !back.isConnected) return;
    if (document.activeElement !== iframeRef.current) return;
    back.focus();
  }, []);

  /** The previewed page's real URL for a proxied one the iframe reports. */
  const unproxied = useCallback((pageUrl: string): string | null => {
    if (nativeRef.current) return pageUrl;
    const p = proxyRef.current;
    if (!p) return null;
    try {
      const u = new URL(pageUrl);
      if (u.host !== `127.0.0.1:${p.port}`) return null;
      return `${p.origin}${u.pathname}${u.search}${u.hash}`;
    } catch {
      return null;
    }
  }, []);
  const unproxiedRef = useRef(unproxied);
  unproxiedRef.current = unproxied;

  /** Answer one op, mapping the page's own idea of its address back to the real
   *  one. Under the proxy the page knows itself as 127.0.0.1:<port>, and agents
   *  must never be told that is where the server lives. */
  const answer = useCallback(
    (id: number, ok: boolean, data: unknown) => {
      let out = data;
      if (!nativeRef.current && out && typeof out === "object") {
        const d = out as { url?: unknown };
        if (typeof d.url === "string") out = { ...d, url: unproxiedRef.current(d.url) ?? d.url };
      }
      // An agent that clicked or typed has changed what the page looks like, so
      // the frame held for the next overlay is of a page that no longer exists.
      if (nativeRef.current) browserPageChanged(tabId);
      void ipc.browserResult(id, ok, out);
    },
    [tabId],
  );

  const postAgentOp = useCallback(
    (op: ipc.AgentBrowserOp) => {
      const bg = !painted();
      if (bg && !nativeRef.current) {
        const active = document.activeElement;
        focusBefore.current =
          active instanceof HTMLElement && active !== iframeRef.current ? active : null;
      }
      const message = {
        canopy: "agent",
        id: op.id,
        op: op.op,
        // Unwatched: the page skips the animated cursor and answers at once.
        bg,
        ref: op.ref ?? undefined,
        selector: op.selector ?? undefined,
        text: op.text ?? undefined,
        label: op.label ?? undefined,
        submit: op.submit ?? undefined,
        append: op.append ?? undefined,
        code: op.code ?? undefined,
        lines: op.lines ?? undefined,
        clear: op.clear ?? undefined,
        max: op.max ?? undefined,
      };
      if (!nativeRef.current) {
        iframeRef.current?.contentWindow?.postMessage(message, "*");
        return;
      }
      // The read-only ops finish inside the call and come straight back;
      // anything cursor-led answers later, through the drained outbox.
      void ipc.browserRunOp(tabId, message).then(
        (ack) => {
          if (!ack) {
            const p = pendingOps.current.get(op.id);
            if (!p) return;
            clearTimeout(p.timer);
            pendingOps.current.delete(op.id);
            answer(
              op.id,
              false,
              "The page isn't ready to be driven yet — it may still be loading. Try canopy_browser_snapshot again in a moment.",
            );
            return;
          }
          if (!ack.done) return;
          const p = pendingOps.current.get(op.id);
          if (!p) return;
          clearTimeout(p.timer);
          pendingOps.current.delete(op.id);
          answer(op.id, !!ack.ok, ack.data);
        },
        (err) => {
          const p = pendingOps.current.get(op.id);
          if (!p) return;
          clearTimeout(p.timer);
          pendingOps.current.delete(op.id);
          answer(op.id, false, String(err));
        },
      );
    },
    [answer, painted, tabId],
  );

  const navigate = useCallback(
    (raw: string) => {
      const target = normalize(raw);
      if (!target) {
        onNotice(`Not a URL: ${raw}`);
        return;
      }
      setDraft(target);
      onPatch({ url: target });
      if (nativeRef.current) {
        if (opened.current) void ipc.browserNavigate(tabId, target).catch(() => {});
        // Not open yet: the create effect picks the new URL up when the tab is
        // next shown, which is the same moment it would have loaded anyway.
        return;
      }
      const p = proxyRef.current;
      if (p && p.origin === originOf(target)) {
        setFrameSrc(`http://127.0.0.1:${p.port}${restOf(target)}`);
      }
      // A different origin re-runs the proxy effect via the `origin` dep.
    },
    [onNotice, onPatch, tabId],
  );

  /** Consecutive off-origin redirects followed, so a redirect loop between two
   *  hosts can't drive the tab forever. Reset by any page that loads. Proxy
   *  only: a real webview follows its own redirects, as a browser should. */
  const redirects = useRef(0);

  /** One picker message, whichever transport carried it. */
  const handleMessage = useCallback(
    (d: Record<string, unknown>) => {
      if (!d || typeof d !== "object" || !("canopy" in d)) return;
      if (d.canopy === "retarget" && typeof d.url === "string") {
        // The page redirected off the proxied origin — most often a public host
        // bumping http to https. The proxy can't serve another origin, so it
        // handed us the destination: re-point the tab, which starts a proxy for
        // the new origin and keeps the page annotatable and drivable. Bounded,
        // because two hosts redirecting to each other would otherwise loop.
        if (redirects.current++ < 5) navigate(d.url);
        else onNotice(`${d.url} keeps redirecting — the preview stopped following it.`);
        return;
      }
      if (d.canopy === "input") {
        // Someone pressed inside the page. The press happened outside this
        // window's event tree — a native child view, or a cross-origin frame —
        // so re-emit it here as the plain fact it is: a click landed in the
        // app, on the browser. Whoever dismisses on clicks elsewhere (the side
        // panel) can then treat the browser like any other surface instead of
        // a hole in the window that clicks fall into.
        window.dispatchEvent(new CustomEvent(BROWSER_INPUT_EVENT));
        return;
      }
      if (d.canopy === "ready") {
        // A document that loads ends the redirect chain.
        redirects.current = 0;
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
        const id = Number(d.id);
        const p = pendingOps.current.get(id);
        if (p) {
          clearTimeout(p.timer);
          pendingOps.current.delete(id);
          restoreFocus();
          answer(id, !!d.ok, d.data);
        }
      } else if (d.canopy === "annotation" && d.payload) {
        const payload = d.payload as Omit<PreviewAnnotation, "comment" | "n">;
        const next: PreviewAnnotation = {
          ...payload,
          pageUrl: unproxied(payload.pageUrl) ?? urlRef.current,
          n: annotationsRef.current.length + 1,
          comment: "",
        };
        onPatch({ annotations: [...annotationsRef.current, next] });
      }
    },
    [answer, navigate, onNotice, onPatch, post, postAgentOp, restoreFocus, unproxied],
  );

  // The picker inside a proxied page talks postMessage; accept only messages
  // from our own iframe's window.
  useEffect(() => {
    if (native) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      handleMessage(e.data);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [native, handleMessage]);

  // A native page's messages arrive drained, in batches, addressed by tab.
  useEffect(() => {
    if (!native) return;
    let un: (() => void) | undefined;
    void ipc
      .onBrowserEvents((e) => {
        if (e.tabId !== tabId) return;
        for (const ev of e.events) handleMessage(ev);
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, [native, tabId, handleMessage]);

  // Real navigations, straight from the platform: the URL bar must be right
  // even for a page that never runs our script (an error page, a download).
  useEffect(() => {
    if (!native) return;
    let un: (() => void) | undefined;
    void ipc
      .onBrowserNav((n) => {
        if (n.tabId !== tabId) return;
        // A frame of the page being navigated away from would freeze the wrong
        // page, so loading throws it away and the next capture earns a new one.
        browserViewChanged(tabId, n.loading);
        if (n.loading) return;
        if (n.url !== urlRef.current) {
          onPatchRef.current({ url: n.url });
          if (!draftFocused.current) setDraft(n.url);
        }
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, [native, tabId]);

  // target=_blank and window.open. A second OS window would be a webview
  // outside every rule the host keeps about where browser pixels may be, so
  // the tab follows the link itself — one tab, one page.
  useEffect(() => {
    if (!native) return;
    let un: (() => void) | undefined;
    void ipc
      .onBrowserPopup((p) => {
        if (p.tabId === tabId) navigate(p.url);
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, [native, tabId, navigate]);

  // Receive agent ops for this tab. Every op carries its own timer, which is
  // what guarantees the bridge always gets an answer — so unmounting flushes
  // nothing. (It used to: with `onPatch` a fresh arrow each ProjectView render,
  // this effect re-ran constantly, and the flush answered in-flight ops with a
  // pre-load URL — or nothing at all if the invoke failed. The timers survive a
  // remount in refs; a re-render must not look like a closed tab.)
  const runOpRef = useRef<(op: ipc.AgentBrowserOp) => void>(() => {});
  runOpRef.current = (op: ipc.AgentBrowserOp) => {
    if (op.op === "navigate") {
      if (op.url) navigate(op.url);
      else if (nativeRef.current)
        void ipc.browserNavigate(tabId, null, op.action ?? "reload").catch(() => {});
      else
        post({
          canopy: "navigate",
          delta: op.action === "back" ? -1 : op.action === "forward" ? 1 : 0,
        });
      // Answered when the page announces itself (ready/nav above); if it never
      // does, report where we got to rather than failing — the navigation
      // itself was issued.
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
    if (op.op === "screenshot") {
      // Pixels, not structure: the DOM snapshot can say a button exists, not
      // that it's sitting on top of the heading.
      //
      // Alone among the ops this one needs the tab actually in front — a
      // snapshot reads what is composited, and a hidden view has nothing in it.
      // ProjectView brings the tab forward before dispatching a screenshot; the
      // delay lets that paint land, and the visibility check catches the cases
      // it can't fix (a hidden project, a minimized window).
      setTimeout(() => {
        const el = nativeRef.current ? hostRef.current : iframeRef.current;
        const rect = el?.getBoundingClientRect();
        if (!rect || !painted() || rect.width < 1 || rect.height < 1) {
          void ipc.browserResult(
            op.id,
            false,
            "The preview isn't visible on screen right now, so there's nothing to capture. The page itself is still there — canopy_browser_snapshot reads it without needing the window.",
          );
          return;
        }
        // Under the webview engine the page is its own view, so it is captured
        // whole; under the proxy it is one rectangle of this window's webview.
        const shot = nativeRef.current
          ? ipc.browserSnapshot(tabId, op.max ?? undefined)
          : ipc.webviewSnapshot(rect.x, rect.y, rect.width, rect.height, op.max ?? undefined);
        void shot
          .then((image) =>
            ipc.browserResult(op.id, true, {
              image,
              mimeType: "image/png",
              url: urlRef.current,
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            }),
          )
          .catch((err) => ipc.browserResult(op.id, false, String(err)));
      }, 60);
      return;
    }
    const timer = window.setTimeout(() => {
      pendingOps.current.delete(op.id);
      restoreFocus();
      void ipc.browserResult(
        op.id,
        false,
        "The page didn't answer — it may still be loading, or stuck. Try canopy_browser_navigate (reload) or check the server with canopy_server_output.",
      );
    }, 12000);
    pendingOps.current.set(op.id, { op, timer });
    postAgentOp(op);
  };

  useEffect(() => registerBrowserTarget(tabId, (op) => runOpRef.current(op)), [tabId]);

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

  const go = (delta: -1 | 0 | 1) => {
    if (native) {
      void ipc
        .browserNavigate(tabId, null, delta === 0 ? "reload" : delta < 0 ? "back" : "forward")
        .catch(() => {});
    } else {
      post({ canopy: "navigate", delta });
    }
  };

  const body = useMemo(() => {
    if (engine === null) return null;
    if (native) {
      // Almost nothing is rendered into this div — it exists to be measured,
      // and the page is a native view browserHost parks on top of it. The one
      // exception is the freeze-frame: while an overlay has pushed the view off
      // screen, this is what stands in for the page.
      return (
        <div ref={hostRef} className="preview-frame preview-webview-host">
          {pane.state === "frozen" && pane.frame && (
            <img className="preview-frozen" src={pane.frame} alt="" draggable={false} />
          )}
        </div>
      );
    }
    if (proxyError) {
      return (
        <div className="preview-error">
          <p>Couldn't reach {origin}.</p>
          <pre>{proxyError}</pre>
          <button className="btn" onClick={() => navigate(urlRef.current)}>
            Retry
          </button>
        </div>
      );
    }
    return frameSrc ? (
      <iframe ref={iframeRef} className="preview-frame" src={frameSrc} title="preview" />
    ) : null;
  }, [engine, native, proxyError, origin, frameSrc, navigate, pane]);

  // ---------- empty tab: pick one of the project's own servers ----------
  // The empty tab offers only servers Canopy can trace back to a component, so
  // feedback marked on the page knows which codebase to change — that's the
  // case this feature exists for, and it's what a fresh tab should suggest.
  // Once a page is open the URL bar (and canopy_browser_navigate) will go
  // anywhere, remote origins included; those pages just have no component link.
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
        <button className="btn-icon" title="Back" onClick={() => go(-1)}>
          ‹
        </button>
        <button className="btn-icon" title="Forward" onClick={() => go(1)}>
          ›
        </button>
        <button className="btn-icon" title="Reload" onClick={() => go(0)}>
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
        <div className="preview-frame-wrap">{body}</div>
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
