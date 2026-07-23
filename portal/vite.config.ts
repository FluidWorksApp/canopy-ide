import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// The Canopy Remote portal is a separate SPA from the desktop app: it is served
// by the embedded axum server (src-tauri/src/portal.rs), not the Tauri webview,
// and baked into the binary from portal/dist via include_dir!. It is mounted at
// /remote, so every asset URL must be prefixed accordingly.
//
// `@shared` is the transport-agnostic module shared with the desktop shell — the
// portal is a thin shell (WebSocket transport + mobile layout) over it.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/remote/',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    fs: { allow: ['..'] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Stable, unhashed asset names. `portal/dist/index.html` is committed (so
    // the crate's include_dir!("../portal/dist") compiles on a fresh checkout),
    // but the assets are gitignored and rebuilt. With content-hashed names the
    // committed index.html referenced files that no longer existed after any
    // rebuild or branch switch — the served portal 404'd its entry JS and
    // rendered a blank page. Fixed filenames keep the committed index.html in
    // permanent sync with whatever the build emits.
    rollupOptions: {
      output: {
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
