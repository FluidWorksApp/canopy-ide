// Canopy preview picker — injected into every page the in-app browser shows,
// under either engine. Runs inside the page, so it can see and describe real
// DOM, and it is the whole of what an agent's browser ops actually do.
//
// Two transports, one script:
//
//   "frame"  — the proxy engine (preview.rs). The page is an iframe inside the
//              Canopy window, served from a loopback origin, and postMessage is
//              the one channel that crosses the origin boundary on purpose.
//   "native" — the webview engine (browser.rs). The page is a real child
//              webview at its real origin, so there is no parent to talk to.
//              The host drives us by evaluating window.__canopyBrowser.*, and
//              we answer into an outbox it drains. A tiny cancelled navigation
//              to the canopy-drain: scheme is the doorbell — see signal().
//
// Protocol (all messages tagged { canopy: <type> }):
//   host -> page: mode {on}, navigate {delta|url}, sync {marks: [{n, selector}]},
//                 agent {id, op, ...} (browser-control ops from MCP agents)
//   page -> host: ready {url, title}, nav {url, title}, annotation {payload},
//                 agent-result {id, ok, data}
(function () {
  "use strict";
  var NATIVE = !!window.__canopyNativeBrowser;
  // Under the proxy the picker belongs to the framed page only; the app's own
  // window loads it too and must skip. A native child webview IS the top
  // window, so that test has to stand down there.
  if (window.__canopyPicker || (!NATIVE && window.top === window)) return;
  window.__canopyPicker = true;

  var picking = false;
  var marks = []; // {n, selector, el|null, badge}
  var Z = 2147483000;

  // ---------- transport ----------

  var outbox = []; // native only: messages waiting for the host to drain
  var drainSeq = 0;
  var signalPending = false;

  /** Ring the host's doorbell. Assigning an unhandled scheme fires the
   *  webview's navigation policy hook, which reads the counter and cancels —
   *  the page is untouched, and the host knows to drain without polling. The
   *  counter matters: re-assigning the same URL is a no-op. */
  function signal() {
    if (signalPending) return;
    signalPending = true;
    setTimeout(function () {
      signalPending = false;
      try {
        location.href = "canopy-drain:" + ++drainSeq;
      } catch (_) {}
    }, 0);
  }

  function send(msg) {
    if (NATIVE) {
      outbox.push(msg);
      signal();
    } else {
      parent.postMessage(msg, "*");
    }
  }

  // ---------- console capture ----------
  // Installed immediately — the proxy injects this script at the top of <head>,
  // so the wrap is in place before the app's own scripts log anything. Agents
  // read the buffer through the canopy_browser_console tool.

  var logs = []; // {level, text, ts}
  var LOG_CAP = 300;

  function logArg(a) {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.stack || String(a);
    try {
      var s = JSON.stringify(a);
      return s && s.length > 500 ? s.slice(0, 500) + "…" : s || String(a);
    } catch (_) {
      return String(a);
    }
  }

  function record(level, args) {
    var text = Array.prototype.map.call(args, logArg).join(" ");
    logs.push({ level: level, text: text.slice(0, 2000), ts: Date.now() });
    if (logs.length > LOG_CAP) logs.splice(0, logs.length - LOG_CAP);
  }

  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      record(level, arguments);
      if (orig) orig.apply(console, arguments);
    };
  });
  addEventListener("error", function (e) {
    record("error", [e.message + (e.filename ? " (" + e.filename + ":" + e.lineno + ")" : "")]);
  });
  addEventListener("unhandledrejection", function (e) {
    record("error", ["Unhandled promise rejection: " + logArg(e.reason)]);
  });

  // ---------- network capture ----------
  // Under the proxy every request passed through Rust and was logged there.
  // A native webview talks to the internet directly, so the log has to be kept
  // in the page: fetch and XHR are wrapped for status and timing, and a
  // PerformanceObserver picks up everything the page requests declaratively
  // (scripts, images, stylesheets, beacons). The one thing neither can see is
  // the document request itself — by the time this script runs, it is done.

  var net = []; // {method, url, status, ms, from, ts}
  var NET_CAP = 300;

  function netPush(entry) {
    net.push(entry);
    if (net.length > NET_CAP) net.splice(0, net.length - NET_CAP);
  }

  function absolute(u) {
    try {
      return new URL(String(u), location.href).href;
    } catch (_) {
      return String(u);
    }
  }

  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      var started = Date.now();
      var url = absolute(input && input.url ? input.url : input);
      var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      return origFetch.apply(this, arguments).then(
        function (res) {
          netPush({
            method: method,
            url: url,
            status: res.status,
            ms: Date.now() - started,
            from: "fetch",
            ts: started,
          });
          return res;
        },
        function (err) {
          netPush({
            method: method,
            url: url,
            status: 0,
            error: String((err && err.message) || err),
            ms: Date.now() - started,
            from: "fetch",
            ts: started,
          });
          throw err;
        },
      );
    };
  }

  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__canopyNet = { method: String(method || "GET").toUpperCase(), url: absolute(url) };
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      var meta = this.__canopyNet;
      if (meta) {
        var started = Date.now();
        var xhr = this;
        this.addEventListener("loadend", function () {
          netPush({
            method: meta.method,
            url: meta.url,
            status: xhr.status,
            ms: Date.now() - started,
            from: "xhr",
            ts: started,
          });
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) {
        // fetch/XHR arrive here too, with worse detail than the wrappers above.
        if (e.initiatorType === "fetch" || e.initiatorType === "xmlhttprequest") return;
        netPush({
          method: "GET",
          url: e.name,
          status: e.responseStatus || null,
          ms: Math.round(e.duration),
          from: e.initiatorType || "resource",
          ts: Math.round(performance.timeOrigin + e.startTime),
        });
      });
    }).observe({ type: "resource", buffered: true });
  } catch (_) {}

  // ---------- overlay chrome ----------

  var hoverBox = document.createElement("div");
  hoverBox.style.cssText =
    "position:fixed;pointer-events:none;z-index:" + Z + ";display:none;" +
    "border:2px solid #4f8ef7;border-radius:3px;background:rgba(79,142,247,.12);" +
    "box-shadow:0 0 0 1px rgba(255,255,255,.6);transition:all .04s linear;";
  var hoverTag = document.createElement("div");
  hoverTag.style.cssText =
    "position:fixed;pointer-events:none;z-index:" + (Z + 1) + ";display:none;" +
    "background:#4f8ef7;color:#fff;font:11px/1.6 -apple-system,system-ui,sans-serif;" +
    "padding:0 6px;border-radius:3px;white-space:nowrap;max-width:60vw;" +
    "overflow:hidden;text-overflow:ellipsis;";

  function ensureChrome() {
    if (!hoverBox.isConnected) document.documentElement.appendChild(hoverBox);
    if (!hoverTag.isConnected) document.documentElement.appendChild(hoverTag);
  }

  function badgeFor(n) {
    var b = document.createElement("div");
    b.textContent = String(n);
    b.style.cssText =
      "position:fixed;z-index:" + (Z + 2) + ";pointer-events:none;" +
      "background:#e8590c;color:#fff;font:bold 11px/18px -apple-system,system-ui,sans-serif;" +
      "min-width:18px;height:18px;text-align:center;border-radius:9px;" +
      "box-shadow:0 1px 4px rgba(0,0,0,.35);padding:0 3px;";
    document.documentElement.appendChild(b);
    return b;
  }

  function layoutBadges() {
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      if (!m.el || !m.el.isConnected) {
        m.el = m.selector ? document.querySelector(m.selector) : null;
      }
      if (m.el && m.el.isConnected) {
        var r = m.el.getBoundingClientRect();
        m.badge.style.display = "block";
        m.badge.style.left = Math.max(0, r.left - 9) + "px";
        m.badge.style.top = Math.max(0, r.top - 9) + "px";
      } else {
        m.badge.style.display = "none";
      }
    }
  }
  addEventListener("scroll", layoutBadges, true);
  addEventListener("resize", layoutBadges);
  setInterval(layoutBadges, 1000); // re-renders move things without events

  // ---------- element description ----------

  function cssPath(el) {
    var path = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      // An id anchors the path — everything above it is redundant.
      if (node.id) {
        path.unshift("#" + CSS.escape(node.id));
        return path.join(" > ");
      }
      var part = node.localName;
      var parent = node.parentElement;
      if (parent) {
        var sibs = Array.prototype.filter.call(parent.children, function (c) {
          return c.localName === node.localName;
        });
        if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(node) + 1) + ")";
      }
      path.unshift(part);
      node = parent;
    }
    return path.join(" > ");
  }

  // Best-effort React component names, walked up the fiber tree — the single
  // most useful hint for finding the source file of what was clicked.
  function reactComponents(el) {
    var key = Object.keys(el).find(function (k) {
      return k.indexOf("__reactFiber$") === 0;
    });
    if (!key) return [];
    var names = [];
    var fiber = el[key];
    while (fiber && names.length < 4) {
      var t = fiber.type;
      var name = typeof t === "function" ? t.displayName || t.name : typeof t === "string" ? null : t && t.displayName;
      if (name && names.indexOf(name) === -1) names.push(name);
      fiber = fiber.return;
    }
    return names;
  }

  function describe(el) {
    var r = el.getBoundingClientRect();
    var html = el.outerHTML || "";
    var text = (el.innerText || "").trim();
    return {
      selector: cssPath(el),
      tag: el.localName,
      id: el.id || null,
      classes: typeof el.className === "string" ? el.className : "",
      text: text.length > 300 ? text.slice(0, 300) + "…" : text,
      html: html.length > 1500 ? html.slice(0, 1500) + "…" : html,
      components: reactComponents(el),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      pageUrl: location.href,
      pageTitle: document.title,
    };
  }

  // ---------- pick mode ----------

  function targetFrom(e) {
    var el = e.target;
    if (!el || el === hoverBox || el === hoverTag) return null;
    if (el === document.documentElement || el === document.body) return null;
    return el;
  }

  function onMove(e) {
    ensureChrome();
    var el = targetFrom(e);
    if (!el) {
      hoverBox.style.display = hoverTag.style.display = "none";
      return;
    }
    var r = el.getBoundingClientRect();
    hoverBox.style.display = "block";
    hoverBox.style.left = r.left + "px";
    hoverBox.style.top = r.top + "px";
    hoverBox.style.width = r.width + "px";
    hoverBox.style.height = r.height + "px";
    var label = el.localName + (el.id ? "#" + el.id : "");
    var comps = reactComponents(el);
    if (comps.length) label += "  ⟨" + comps[0] + "⟩";
    hoverTag.textContent = label;
    hoverTag.style.display = "block";
    hoverTag.style.left = r.left + "px";
    hoverTag.style.top = Math.max(0, r.top - 22) + "px";
  }

  function onClick(e) {
    var el = targetFrom(e);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    var payload = describe(el);
    var n = marks.length + 1;
    marks.push({ n: n, selector: payload.selector, el: el, badge: badgeFor(n) });
    layoutBadges();
    send({ canopy: "annotation", n: n, payload: payload });
  }

  function swallow(e) {
    // In pick mode the page must not react to the probing click.
    if (targetFrom(e)) { e.preventDefault(); e.stopPropagation(); }
  }

  function setPicking(on) {
    if (picking === on) return;
    picking = on;
    ensureChrome();
    var m = on ? "addEventListener" : "removeEventListener";
    document[m]("mousemove", onMove, true);
    document[m]("click", onClick, true);
    document[m]("mousedown", swallow, true);
    document[m]("mouseup", swallow, true);
    if (!on) hoverBox.style.display = hoverTag.style.display = "none";
    document.documentElement.style.cursor = on ? "crosshair" : "";
  }

  function clearMarks() {
    marks.forEach(function (m) { m.badge.remove(); });
    marks = [];
  }

  // Restore badges the app still holds (after a reload / tab revisit).
  function syncMarks(list) {
    clearMarks();
    (list || []).forEach(function (item) {
      var el = null;
      try { el = document.querySelector(item.selector); } catch (_) {}
      marks.push({ n: item.n, selector: item.selector, el: el, badge: badgeFor(item.n) });
    });
    layoutBadges();
  }

  // ---------- navigation reporting ----------

  function announce(type) {
    send({ canopy: type, url: location.href, title: document.title });
  }
  var pushState = history.pushState.bind(history);
  history.pushState = function () { pushState.apply(null, arguments); announce("nav"); };
  var replaceState = history.replaceState.bind(history);
  history.replaceState = function () { replaceState.apply(null, arguments); announce("nav"); };
  addEventListener("popstate", function () { announce("nav"); });
  addEventListener("hashchange", function () { announce("nav"); });

  // ---------- agent browser control ----------
  // Ops arrive from MCP tools (canopy_browser_*) relayed by the app. Every op
  // answers with agent-result {id, ok, data}; refs from the last snapshot are
  // how click/type address elements without brittle selectors.

  var agentRefs = []; // elements handed out as refs by the last snapshot

  // ---------- agent cursor ----------
  // An agent acting on the page has to be *visible*, or a remote click is
  // indistinguishable from the page doing something on its own. So the pointer
  // travels to the target, rests on it, and only then does the action fire —
  // the user sees what is about to happen, and where.

  var CURSOR_MOVE_MS = 320;
  var CURSOR_SETTLE_MS = 160; // let a smooth scroll land before aiming
  var ACCENT = "#4f8ef7";
  var cursorEl = null;
  var cursorLabelEl = null;
  var cursorHideTimer = 0;
  // Set per op by the parent: true when the preview tab is open but not the one
  // in front, so nobody is watching this page. The choreography is for the
  // user's benefit — with no user it's just a second of latency per op — so a
  // background op behaves like reduced motion and fires immediately.
  var unwatched = false;

  function reducedMotion() {
    return unwatched || !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function ensureCursor() {
    if (cursorEl && cursorEl.isConnected) return;
    cursorEl = document.createElement("div");
    cursorEl.style.cssText =
      "position:fixed;left:0;top:0;z-index:" + (Z + 6) + ";pointer-events:none;opacity:0;" +
      "transform:translate(-200px,-200px);will-change:transform,opacity;";
    cursorEl.innerHTML =
      '<svg width="22" height="26" viewBox="0 0 22 26" style="display:block;' +
      'filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))">' +
      '<path d="M2 2 L2 19.5 L6.9 15.1 L10 22.2 L13.2 20.8 L10.1 13.9 L17.2 13.7 Z" fill="' +
      ACCENT + '" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    cursorLabelEl = document.createElement("div");
    cursorLabelEl.style.cssText =
      "position:absolute;left:19px;top:21px;background:" + ACCENT + ";color:#fff;" +
      "font:600 10px/17px -apple-system,system-ui,sans-serif;padding:0 7px;border-radius:9px;" +
      "white-space:nowrap;max-width:40vw;overflow:hidden;text-overflow:ellipsis;" +
      "box-shadow:0 1px 4px rgba(0,0,0,.35);";
    cursorEl.appendChild(cursorLabelEl);
    // On documentElement, not body: keeps it out of body.innerText, so a
    // snapshot never reports the cursor's own label as page content.
    document.documentElement.appendChild(cursorEl);
  }

  function hideCursorSoon(delay) {
    clearTimeout(cursorHideTimer);
    cursorHideTimer = setTimeout(function () {
      if (cursorEl) cursorEl.style.opacity = "0";
    }, delay || 1600);
  }

  /** Outline the element being acted on, so "where" is unambiguous. */
  function flashBox(el, ms) {
    var r = el.getBoundingClientRect();
    var b = document.createElement("div");
    b.style.cssText =
      "position:fixed;pointer-events:none;z-index:" + (Z + 4) + ";border-radius:4px;" +
      "left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px;" +
      "border:2px solid " + ACCENT + ";background:rgba(79,142,247,.10);transition:opacity .3s;";
    document.documentElement.appendChild(b);
    setTimeout(function () {
      b.style.opacity = "0";
      setTimeout(function () { b.remove(); }, 320);
    }, ms || 700);
  }

  /** Expanding ring at the click point — the "tap". */
  function ripple(x, y) {
    var r = document.createElement("div");
    r.style.cssText =
      "position:fixed;left:" + x + "px;top:" + y + "px;z-index:" + (Z + 5) + ";" +
      "pointer-events:none;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;" +
      "border:2px solid " + ACCENT + ";background:rgba(79,142,247,.25);" +
      "transition:transform .45s ease-out,opacity .45s ease-out;";
    document.documentElement.appendChild(r);
    requestAnimationFrame(function () {
      r.style.transform = "scale(2.6)";
      r.style.opacity = "0";
    });
    setTimeout(function () { r.remove(); }, 520);
  }

  /** Bring the pointer to `el` and resolve with the point it landed on. */
  function withCursor(el, label) {
    ensureCursor();
    var instant = reducedMotion();
    el.scrollIntoView({ block: "center", inline: "center", behavior: instant ? "auto" : "smooth" });
    clearTimeout(cursorHideTimer);
    cursorLabelEl.textContent = label;
    return new Promise(function (resolve) {
      setTimeout(function () {
        var r = el.getBoundingClientRect();
        var x = Math.round(r.left + r.width / 2);
        var y = Math.round(r.top + r.height / 2);
        cursorEl.style.transition = instant
          ? "opacity .1s"
          : "transform " + CURSOR_MOVE_MS + "ms cubic-bezier(.22,.61,.36,1),opacity .15s";
        cursorEl.style.opacity = "1";
        cursorEl.style.transform = "translate(" + x + "px," + y + "px)";
        setTimeout(function () { resolve({ x: x, y: y }); }, instant ? 0 : CURSOR_MOVE_MS);
      }, instant ? 0 : CURSOR_SETTLE_MS);
    });
  }

  function visible(el) {
    if (!el.getClientRects().length) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  function labelFor(el) {
    var t =
      el.getAttribute("aria-label") ||
      (el.innerText || "").trim() ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.getAttribute("alt") ||
      (el.localName === "input" ? el.value : "") ||
      "";
    return t.replace(/\s+/g, " ").slice(0, 80);
  }

  function snapshotPage(d) {
    var sel =
      "a[href],button,input,select,textarea,summary,[role=button],[role=link]," +
      "[role=tab],[role=checkbox],[role=radio],[role=menuitem],[role=option]," +
      "[role=switch],[role=combobox],[onclick],[contenteditable=true],[contenteditable='']";
    var all = document.querySelectorAll(sel);
    agentRefs = [];
    var els = [];
    var cap = Math.min(Number(d.max) || 150, 400);
    for (var i = 0; i < all.length && agentRefs.length < cap; i++) {
      var el = all[i];
      if (!visible(el)) continue;
      agentRefs.push(el);
      var entry = {
        ref: agentRefs.length,
        tag: el.localName,
        text: labelFor(el),
        selector: cssPath(el),
      };
      var role = el.getAttribute("role");
      if (role) entry.role = role;
      if (el.localName === "a") entry.href = el.getAttribute("href");
      if (el.localName === "input" || el.localName === "textarea" || el.localName === "select") {
        entry.value = String(el.value == null ? "" : el.value).slice(0, 120);
        if (el.type) entry.type = el.type;
        if (el.checked != null && (el.type === "checkbox" || el.type === "radio"))
          entry.checked = el.checked;
      }
      if (el.disabled) entry.disabled = true;
      var comps = reactComponents(el);
      if (comps.length) entry.component = comps[0];
      els.push(entry);
    }
    var text = (document.body && document.body.innerText) || "";
    return {
      url: location.href,
      title: document.title,
      text: text.length > 6000 ? text.slice(0, 6000) + "\n…(page text truncated)" : text,
      elements: els,
      elementsTruncated: agentRefs.length >= cap && all.length > agentRefs.length,
    };
  }

  function resolveTarget(d) {
    if (d.ref != null) {
      var el = agentRefs[Number(d.ref) - 1];
      if (!el || !el.isConnected)
        throw new Error(
          "ref " + d.ref + " is stale (the page re-rendered) — call canopy_browser_snapshot again",
        );
      return el;
    }
    if (d.selector) {
      var found = document.querySelector(d.selector);
      if (!found) throw new Error("no element matches selector: " + d.selector);
      return found;
    }
    throw new Error("pass a ref (from canopy_browser_snapshot) or a CSS selector");
  }

  function clickTarget(el) {
    // Scrolling into view is the cursor's job now (withCursor), so the pointer
    // aims at where the element ends up rather than where it started.
    var r = el.getBoundingClientRect();
    var opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: r.x + r.width / 2,
      clientY: r.y + r.height / 2,
    };
    if (el.focus) el.focus();
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(function (type) {
      el.dispatchEvent(new MouseEvent(type, opts));
    });
  }

  function typeInto(el, d) {
    if (el.focus) el.focus();
    var text = String(d.text == null ? "" : d.text);
    if (el.localName === "input" || el.localName === "textarea") {
      // Through the prototype's setter so controlled (React) inputs see it.
      var proto = el.localName === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, "value");
      var next = d.append ? el.value + text : text;
      if (desc && desc.set) desc.set.call(el, next);
      else el.value = next;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.localName === "select") {
      var opt = Array.prototype.find.call(el.options, function (o) {
        return o.value === text || o.textContent.trim() === text;
      });
      if (!opt) throw new Error('no <option> matches "' + text + '"');
      el.value = opt.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      document.execCommand("selectAll", false, null);
      if (!d.append) document.execCommand("delete", false, null);
      else window.getSelection().collapseToEnd();
      document.execCommand("insertText", false, text);
    } else {
      throw new Error("<" + el.localName + "> is not a text input, select, or contenteditable");
    }
    if (d.submit) {
      var key = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13 };
      el.dispatchEvent(new KeyboardEvent("keydown", key));
      el.dispatchEvent(new KeyboardEvent("keyup", key));
    }
  }

  // JSON-safe copy for eval results: cycles, functions and DOM nodes flattened.
  function safeValue(v, seen, depth) {
    if (v === undefined) return null;
    if (v === null || typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "string") return v.length > 4000 ? v.slice(0, 4000) + "…" : v;
    if (typeof v === "function") return "[function " + (v.name || "anonymous") + "]";
    if (v instanceof Element) return "<" + v.localName + "> " + cssPath(v);
    if (v instanceof Error) return String(v.stack || v);
    if (depth > 4) return "[…depth]";
    if (seen.indexOf(v) !== -1) return "[cyclic]";
    seen.push(v);
    if (Array.isArray(v)) {
      return v.slice(0, 100).map(function (x) { return safeValue(x, seen, depth + 1); });
    }
    var out = {};
    var keys = Object.keys(v).slice(0, 100);
    for (var i = 0; i < keys.length; i++) out[keys[i]] = safeValue(v[keys[i]], seen, depth + 1);
    return out;
  }

  // Set for the duration of one native run(), so a reply that lands before the
  // call returns can be handed straight back instead of via the outbox — the
  // read-only ops (snapshot, console, network) all answer that way, and a
  // direct return is one round trip where the doorbell would be three.
  var inlineReply = null;

  function agentReply(id, ok, data) {
    var msg = { canopy: "agent-result", id: id, ok: ok, data: data };
    if (inlineReply && inlineReply.id === id) {
      inlineReply.msg = msg;
      return;
    }
    send(msg);
  }

  function runAgentOp(d) {
    switch (d.op) {
      case "snapshot":
        return agentReply(d.id, true, snapshotPage(d));
      case "click": {
        var el = resolveTarget(d);
        var brief = { tag: el.localName, text: labelFor(el), selector: cssPath(el) };
        return withCursor(el, "click").then(function (p) {
          flashBox(el, 500);
          ripple(p.x, p.y);
          clickTarget(el);
          hideCursorSoon();
          agentReply(d.id, true, { clicked: brief, url: location.href });
        });
      }
      case "type": {
        var t = resolveTarget(d);
        return withCursor(t, "type").then(function () {
          flashBox(t, 900);
          typeInto(t, d);
          hideCursorSoon();
          agentReply(d.id, true, {
            typed: String(d.text == null ? "" : d.text).slice(0, 120),
            into: { tag: t.localName, selector: cssPath(t) },
            submitted: !!d.submit,
          });
        });
      }
      case "point": {
        var pt = resolveTarget(d);
        var label = d.label ? String(d.label).slice(0, 60) : "look here";
        return withCursor(pt, label).then(function () {
          flashBox(pt, 1600);
          hideCursorSoon(2600);
          agentReply(d.id, true, {
            pointingAt: { tag: pt.localName, text: labelFor(pt), selector: cssPath(pt) },
            label: label,
          });
        });
      }
      case "eval": {
        var fn;
        try {
          fn = new Function('"use strict";return (' + d.code + ")");
        } catch (_) {
          fn = new Function('"use strict";' + d.code);
        }
        return Promise.resolve(fn()).then(
          function (v) { agentReply(d.id, true, { result: safeValue(v, [], 0) }); },
          function (err) { agentReply(d.id, false, String((err && err.stack) || err)); },
        );
      }
      case "console": {
        var n = Math.min(Number(d.lines) || 100, LOG_CAP);
        var out = logs.slice(-n);
        if (d.clear) logs.length = 0;
        return agentReply(d.id, true, { messages: out, total: logs.length });
      }
      case "network": {
        var m = Math.min(Number(d.lines) || 100, NET_CAP);
        return agentReply(d.id, true, {
          requests: net.slice(-m),
          total: net.length,
          note: "Captured in the page (fetch, XHR and subresources). The document request itself happened before this script ran, so it isn't listed.",
        });
      }
      default:
        return agentReply(d.id, false, "unknown browser op: " + d.op);
    }
  }

  function onAgentMessage(d) {
    unwatched = !!d.bg;
    var fail = function (err) {
      agentReply(d.id, false, String((err && err.message) || err));
    };
    var exec = function () {
      try {
        // Cursor-led ops (click/type/point) and eval resolve asynchronously;
        // an async failure must answer too, or the agent waits out its timeout.
        var running = runAgentOp(d);
        if (running && typeof running.then === "function") running.then(null, fail);
      } catch (err) {
        fail(err);
      }
    };
    // The script runs from <head>, so an op can land before the body exists.
    if (document.readyState === "loading") addEventListener("DOMContentLoaded", exec, { once: true });
    else exec();
  }

  // ---------- host commands ----------

  function onHostMessage(d) {
    if (!d || typeof d !== "object") return;
    if (d.canopy === "mode") setPicking(!!d.on);
    else if (d.canopy === "sync") syncMarks(d.marks);
    else if (d.canopy === "agent") onAgentMessage(d);
    else if (d.canopy === "navigate") {
      if (typeof d.url === "string") location.href = d.url;
      else if (d.delta === 0) location.reload();
      else if (typeof d.delta === "number") history.go(d.delta);
    }
  }

  if (NATIVE) {
    // The host reaches these by evaluating JavaScript in this webview and
    // reading the returned value, so everything here must be JSON-serialisable
    // and must not throw across the boundary — an exception there comes back
    // indistinguishable from `undefined`.
    window.__canopyBrowser = {
      cmd: function (d) {
        try {
          onHostMessage(d);
          return true;
        } catch (err) {
          return String((err && err.message) || err);
        }
      },
      /** Start an op. Read-only ops finish inside this call and their result
       *  comes straight back; anything cursor-led or async answers later
       *  through the outbox. */
      run: function (d) {
        d = d || {};
        d.canopy = "agent";
        inlineReply = { id: d.id, msg: null };
        var done;
        try {
          onHostMessage(d);
        } finally {
          done = inlineReply.msg;
          inlineReply = null;
        }
        return done ? { done: true, ok: done.ok, data: done.data } : { done: false };
      },
      drain: function () {
        var out = outbox;
        outbox = [];
        return out;
      },
      /** Where the page thinks it is — the URL bar's source of truth for
       *  in-page (pushState) navigations the host's page-load hook can't see. */
      here: function () {
        return { url: location.href, title: document.title };
      },
    };
  } else {
    addEventListener("message", function (e) {
      onHostMessage(e.data);
    });
  }

  announce("ready");
})();
