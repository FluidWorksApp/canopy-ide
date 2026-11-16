import { describe, expect, it, vi } from "vitest";
import { SHOW_WORKSPACE_EVENT } from "../readableLinks";
import { requestTargetTransition } from "./transitions";

describe("machine transitions", () => {
  it("preserves the exact remote workspace ID", async () => {
    const listener = vi.fn();
    window.addEventListener(SHOW_WORKSPACE_EVENT, listener);
    await requestTargetTransition({ kind: "remote", workspaceId: "workspace-precise" });
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      workspaceId: "workspace-precise",
      connect: true,
    });
    window.removeEventListener(SHOW_WORKSPACE_EVENT, listener);
  });
});
