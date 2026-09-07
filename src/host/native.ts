import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Host } from "./contract";

/** Native IPC remains the desktop implementation of the common host API. */
export const nativeHost: Host = {
  kind: "native",
  invoke,
  listen,
  channel: <T>() => new Channel<T>(),
};
