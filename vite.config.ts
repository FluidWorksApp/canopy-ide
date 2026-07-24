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
