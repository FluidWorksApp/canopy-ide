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
  },
})
