// The portal's service worker. It exists for exactly one job: keep an agent
// notification alive when the tab is backgrounded, and bring the tab back when
// you tap it.
//
// Deliberately NOT a cache: the portal is served from the desktop app that owns
// the data, so a stale cached shell would be a phone confidently showing you
// yesterday's agents. The asset URLs are already immutable and the entry point
// is `no-cache` (see cache_control in portal.rs) — the network is the right
// source here.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const scope = data.scope || '/remote/'
  // Focus a tab that is already open rather than opening a second one — the
  // first still holds the live WebSocket and the terminal's scrollback.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(scope)) {
          client.postMessage({ t: 'open-pty', pty: data.pty ?? null })
          return client.focus()
        }
      }
      const url = data.pty != null ? `${scope}#pty=${data.pty}` : scope
      return self.clients.openWindow(url)
    }),
  )
})
