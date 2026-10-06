import { createRoot } from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { registerRendererWithRetry } from "../rendererRegistration";
import { startRendererHeartbeat } from "../rendererHeartbeat";
import { RemoteWorkspaceApp } from "./RemoteWorkspaceApp";
import "./remote.css";

// Preserve the native host's existing PTYs while replacing local UI ownership.
// This handshake detaches their dead channels; it never spawns or kills one.
if (isTauri()) {
  void registerRendererWithRetry(() => invoke<{ generation: number }>("pty_renderer_register"), () => {})
    .then(({ generation }) => startRendererHeartbeat(() => invoke("watchdog_ack", { generation })));
}
createRoot(document.getElementById("root")!).render(<RemoteWorkspaceApp />);
