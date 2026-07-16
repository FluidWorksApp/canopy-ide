import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
