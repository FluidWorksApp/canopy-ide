// Canopy preview storage keeper — inlined at the top of <head> on every page
// the proxy serves, ahead of the page's own scripts (see preview.rs).
//
// The page is a third-party frame, and WebKit keeps a third-party frame's
// localStorage in memory only, so a login that lives there (most SPAs) is gone
// after an app restart. This mirrors the whole store to the proxy, which keeps
// it on disk, and on a fresh process — an empty store — puts it back before
// the page's own code looks.
//
// The proxy fills in hasSaved below (true when it holds a saved copy), so
// pages with nothing saved never wait on the synchronous read.
(function () {
  "use strict";
  var PATH = "/__canopy__/storage";
  var HEADER = "X-Canopy-Storage";
  var store;
  try {
    store = window.localStorage;
  } catch (e) {
    return;
  }
  if (!store || window.__canopyStorage) return;
  window.__canopyStorage = true;
  // Captured before the page or the picker can wrap it, so a save never runs
  // through an app's request interceptors.
  var send = window.fetch;

  // Live storage always wins: only an empty store is seeded, and only with
  // keys it still lacks. A non-empty store means this process already has the
  // page's real state, newer than anything saved.
  var hasSaved = __CANOPY_SAVED__;
  var seeded = false;
  var failed = false;
  if (hasSaved && store.length === 0) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", PATH, false);
      xhr.setRequestHeader(HEADER, "1");
      xhr.send();
      if (xhr.status !== 200) throw new Error("status " + xhr.status);
      var saved = JSON.parse(xhr.responseText);
      for (var key in saved) {
        if (Object.prototype.hasOwnProperty.call(saved, key) && store.getItem(key) === null) {
          store.setItem(key, String(saved[key]));
        }
      }
      seeded = true;
    } catch (e) {
      failed = true;
    }
  }
  // A failed restore leaves the store empty through no choice of the page's.
  // Saving that would erase the login it failed to restore, so nothing is
  // saved until the page itself writes.
  var touched = !failed;

  function snapshot() {
    var out = {};
    for (var i = 0; i < store.length; i++) {
      var k = store.key(i);
      if (k !== null) out[k] = store.getItem(k);
    }
    return JSON.stringify(out);
  }

  // The whole store each time, never a delta: a logout or clear() must reach
  // the saved copy too, or the next run would bring the old session back.
  // What the saved copy already holds, so an unchanged store isn't re-sent.
  var sent = null;
  try {
    if (seeded) sent = snapshot();
    else if (!hasSaved && store.length === 0) sent = "{}";
  } catch (e) {}
  var timer = 0;
  function save(unloading) {
    if (timer) clearTimeout(timer);
    timer = 0;
    if (!touched) return;
    var body;
    try {
      body = snapshot();
    } catch (e) {
      return;
    }
    if (body === sent) return;
    sent = body;
    try {
      send
        .call(window, PATH, {
          method: "POST",
          headers: { "X-Canopy-Storage": "1", "Content-Type": "application/json" },
          body: body,
          credentials: "same-origin",
          // keepalive lets the last save outlive the page, within its 64 KiB cap.
          keepalive: !!unloading && body.length < 60000,
        })
        .then(
          function (response) {
            if (!response.ok && sent === body) sent = null;
          },
          function () {
            if (sent === body) sent = null;
          }
        );
    } catch (e) {
      sent = null;
    }
  }
  // Each save sends the whole store, which can be large (chat history and the
  // like), so bursts of writes are folded into one save a second.
  function saveSoon() {
    if (!timer) timer = setTimeout(save, 1000);
  }

  var proto = Storage.prototype;
  ["setItem", "removeItem", "clear"].forEach(function (name) {
    var original = proto[name];
    proto[name] = function () {
      var result = original.apply(this, arguments);
      if (this === store) {
        touched = true;
        saveSoon();
      }
      return result;
    };
  });
  // Another tab of this origin changed the shared store.
  window.addEventListener("storage", function (event) {
    if (event.storageArea === store) {
      touched = true;
      saveSoon();
    }
  });
  // Writes by property assignment (store.x = 1) skip setItem; the page
  // leaving or hiding catches those, as does the first save after load.
  window.addEventListener("pagehide", function () {
    save(true);
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") save(true);
  });
  setTimeout(save, 1000);
})();
