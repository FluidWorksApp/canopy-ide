import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Library build. react/react-dom stay external so a consuming app supplies the
// single React instance — bundling a second copy breaks hooks at runtime.
export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "CanopyUI",
      formats: ["es"],
      fileName: () => "canopy-ui.js",
      // Without this the stylesheet is named after the directory ("ui.css"),
      // which silently diverges from what package.json#exports advertises.
      cssFileName: "canopy-ui",
    },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime"],
    },
    // Tokens are the contract every consumer needs; keep them readable.
    cssMinify: false,
  },
});
