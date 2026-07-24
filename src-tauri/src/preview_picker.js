// Canopy preview picker — injected into every HTML page the preview proxy
// serves. Runs inside the previewed page, so it can see and describe real DOM;
// talks to the Canopy app (the iframe's parent) via postMessage, which is the
// one channel that crosses the origin boundary on purpose.
//
// Protocol (all messages tagged { canopy: <type> }):
//   parent -> page: mode {on}, navigate {delta|url}, sync {marks: [{n, selector}]}
//   page -> parent: ready {url, title}, nav {url, title}, annotation {payload}
(function () {
  "use strict";
  if (window.__canopyPicker || window.top === window) return;
  window.__canopyPicker = true;

  var picking = false;
  var marks = []; // {n, selector, el|null, badge}
  var Z = 2147483000;

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
    parent.postMessage({ canopy: "annotation", n: n, payload: payload }, "*");
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
    parent.postMessage({ canopy: type, url: location.href, title: document.title }, "*");
  }
  var pushState = history.pushState.bind(history);
  history.pushState = function () { pushState.apply(null, arguments); announce("nav"); };
  var replaceState = history.replaceState.bind(history);
  history.replaceState = function () { replaceState.apply(null, arguments); announce("nav"); };
  addEventListener("popstate", function () { announce("nav"); });
  addEventListener("hashchange", function () { announce("nav"); });

  // ---------- parent commands ----------

  addEventListener("message", function (e) {
    var d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.canopy === "mode") setPicking(!!d.on);
    else if (d.canopy === "sync") syncMarks(d.marks);
    else if (d.canopy === "navigate") {
      if (typeof d.url === "string") location.href = d.url;
      else if (d.delta === 0) location.reload();
      else if (typeof d.delta === "number") history.go(d.delta);
    }
  });

  announce("ready");
})();
