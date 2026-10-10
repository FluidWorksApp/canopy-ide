# Chrome streaming preview

Select **Settings → Browser → Playwright** and reopen a
preview tab. Install the official [Playwright Chrome extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)
and have Node.js 20+ available. Approve the connection in Chrome. Canopy creates
its own tab in that profile, preserving the user's existing logins.

Chrome executes the website. A local iframe in Canopy renders JPEG frames on a
canvas and forwards mouse, keyboard, paste and composition input. IDE overlays
can cover any part of the iframe without hiding the website. Hidden preview
tabs pause screencasting; this is a bandwidth optimization, not native-window
occlusion choreography. The website and agent commands continue to run.

Chrome emits screencast frames only while it composites the tab, so an IDE
window covering Chrome can leave the preview on a stale frame. When frames stop
arriving the bridge restarts the screencast, which makes Chrome produce one on
the spot; a picture identical to the last is dropped and the retry backs off, so
an idle preview costs almost nothing. `Page.captureScreenshot` is deliberately
not used for this: it fails for a background tab and hangs outright for a
minimized window. The viewer scales each frame to the pane, because the
extension relay cannot resize the real Chrome window and the frame that arrives
may be smaller or a different shape than the preview.

The existing annotation picker runs in Chrome with a Playwright binding as its
return channel. Screenshots come from the real Chrome page. Popups created by
the project tab appear in the viewer's tab selector. Basic JavaScript dialogs
are answered inside the iframe. Closing the preview closes only this bridge's
tabs and detaches from Chrome, leaving personal tabs alone.

## Workspace recovery and display quality

The viewer retries dropped sockets with fresh one-use tickets, pauses retry
work while hidden, and resumes when the preview returns. Ticket and handshake
waits have deadlines. Repeated failures or a fenced Chrome session ask the IDE
to reopen the bridge with the same tab profile and latest URL. Refresh survives
socket reconnects; mouse and keyboard events are never replayed. A reconnect
receives a fresh frame even when the page's pixels have not changed.

Workspace previews match the viewing display's pixel density up to 2×, capped
at 3840×2400 physical pixels. An explicit compositor viewport preserves CSS
layout and pointer coordinates while avoiding canvas upscaling on retina
screens. JPEG quality is 90. Screenshots report their actual PNG dimensions.
Controls have a separate bounded queue, so a slow navigation or picker cannot
hold pointer and keyboard input; a later navigation cancels an earlier load.

The release workflow runs the real Chromium recovery fixture inside the
candidate image before publishing. To run it locally with Chromium installed:

```sh
node packages/remote-host/prepare-browser-build.mjs
node packages/chrome-stream/recovery-smoke.mjs
```

This uses disposable local pages, profiles, tickets and browser processes. It
checks transient reconnects, project hiding, expired bridge replacement,
persistent cookies/storage, dev-server restart, input during stalled navigation,
retina pixels, screenshot dimensions and pointer coordinates. It does not pair
with a personal Chrome profile or contact an external website.

## Build and test

`npm install` installs the exact-pinned Playwright package. `npm run build:hook`
stages the Node bridge and dependency into Tauri's resource directory before
building the hook. Node itself is supplied by the user's development environment.

```sh
node scripts/prepare-chrome-stream.mjs
node --test packages/chrome-stream/protocol.test.mjs
node packages/chrome-stream/smoke.mjs --viewer
node packages/chrome-stream/smoke.mjs --isolated --viewer
```

The smoke test opens a local disposable fixture through the installed extension;
approve its Canopy connection in Chrome. `--viewer` additionally renders the
iframe in a disposable headless Chrome instance, checks typing and overlay
layering, and writes `/private/tmp/canopy-chrome-stream.png`. The product does
not launch a second browser engine for its viewer.
`--isolated` injects a disposable headless browser in place of the extension
connection for unattended tests; it does not verify extension compatibility.

## Prototype boundaries

- The two browser choices are **Embedded** (the default iframe) and
  **Playwright**. Saved native-webview preferences migrate to Embedded;
  existing iframe and Playwright choices are preserved. Playwright remains a
  prototype pending platform validation. The stream's own recovery is measured
  against a background tab and a minimized window driven over a direct CDP
  session; occlusion behaviour through the extension relay, on every platform,
  is not yet covered by a test.
- One Node bridge/extension connection per Canopy preview tab. Each connection
  asks for approval in Chrome unless the user saves the extension's token in
  Settings → Browser; Canopy keeps it in the OS credential store (Keychain on
  macOS) and passes it to the bridge as `PLAYWRIGHT_MCP_EXTENSION_TOKEN`.
- `playwright.mjs` isolates the pinned internal extension factory and existing
  page CDP session. Public `newCDPSession()` does not work through the extension
  because it attempts to attach to the browser target. Upgrade this adapter
  only with the live smoke test.
- This streams page content, not Chrome's toolbar, native menus, permission
  sheets, password manager, or OS file pickers. Audio/video media streaming,
  native drag/drop and full clipboard synchronization are not implemented.
  Those interactions may require the real Chrome window.
- The separate agent picture-in-picture/remote portal paths still support the
  existing engine only; this change targets the main browser pane.
- The loopback server has a random capability URL, exact Host/Origin checks,
  one viewer per bridge, bounded input/frame queues and no disk frame cache.
  The iframe gets no Tauri permissions. Do not expose its URL over the network.
- Chrome profile cookies are shared deliberately. Project tab grouping does
  not provide separate authentication or browser-profile isolation.
