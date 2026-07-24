import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// A dedicated Vitest config rather than a `test` block in vite.config.ts: the
// build config carries the material-icon-theme asset rule, which is irrelevant
// under jsdom and only muddies the two concerns. The React plugin is shared so
// JSX/TSX in tests transforms the same way it does in the app.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "shared/**/*.test.{ts,tsx}", "packages/**/src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      // Only the modules we actually target — reporting 0% for the whole tree
      // (Monaco setup, IPC glue, giant views) would drown the signal.
      include: [
        "src/collab-ot.ts",
        "src/settings.ts",
        "src/pricing.ts",
        "src/markdown.ts",
        "src/projects.ts",
      ],
    },
  },
});
