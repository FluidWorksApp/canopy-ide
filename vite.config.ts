import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// MIT, BSD, ISC and Apache-2.0 all require their copyright and permission
// notices to travel with the binary, not just sit in the GitHub repo. dist/ is
// Tauri's frontendDist and is embedded in the app bundle, so emitting the
// notices here is what actually ships them. Sourced from the repo root so there
// is exactly one copy to keep current (see scripts/generate-third-party-notices.mjs).
function thirdPartyNotices(): Plugin {
  const src = fileURLToPath(new URL('./THIRD-PARTY-NOTICES.md', import.meta.url))
  return {
    name: 'canopy-third-party-notices',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD-PARTY-NOTICES.md',
        source: readFileSync(src, 'utf8'),
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), thirdPartyNotices()],
  server: {
    // tauri.conf.json's devUrl is a fixed http://localhost:5173. Vite's default
    // is to step aside when that port is taken and quietly serve on the next
    // free one — which does not move the webview, so `tauri dev` compiles this
    // checkout, opens a window, and loads whatever else already owned 5173.
    //
    // That is not hypothetical. A Vite left running from an unrelated worktree
    // owned 5173 for a day; every dev run since served that worktree's
    // frontend, and the symptom was a fix that "did not work" while its source
    // was demonstrably correct — the running JavaScript was another branch's.
    // Refusing to start is the only honest outcome: a dev server on the wrong
    // port is worse than no dev server, because it looks like it worked.
    strictPort: true,
  },
  build: {
    // The file-type icons (material-icon-theme, ~1250 SVGs) all sit under the
    // 4KB default inline limit, so Vite embeds every one as a data: URI in the
    // main chunk — a 5MB index.js the webview parses at startup just to draw
    // the ~20 icons on screen. Emit them as files instead; the webview then
    // fetches only the handful a folder actually renders. Returning undefined
    // leaves every other asset on Vite's default behaviour.
    assetsInlineLimit: (filePath) =>
      filePath.includes('material-icon-theme') ? false : undefined,
  },
})
