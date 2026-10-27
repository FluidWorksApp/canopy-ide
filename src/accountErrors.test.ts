import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { NOT_ON_SERVER_YET, notOnServerYet, serverFeatureError } from "./accountErrors";
import { copyReadableLink } from "./readableLinks";
import { requestMoreCredit } from "./credits";

describe("account requests to a server older than the app", () => {
  it("recognises a missing route and a verb the route doesn't take", () => {
    expect(notOnServerYet(NOT_ON_SERVER_YET)).toBe(true);
    expect(notOnServerYet(new Error("Method not allowed"))).toBe(true);
    expect(notOnServerYet("Sign in first")).toBe(false);
  });

  it("says the feature isn't on the server yet, and passes other errors through", () => {
    expect(serverFeatureError(NOT_ON_SERVER_YET, "Readable links").message).toMatch(/^Readable links: not available on Canopy's server yet/);
    expect(serverFeatureError("Method not allowed", "Add funds").message).toMatch(/^Add funds: not available/);
    expect(serverFeatureError(new Error("Sign in first"), "Add funds").message).toBe("Sign in first");
  });

  it("Copy link explains an old server instead of showing a raw error", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(NOT_ON_SERVER_YET);
    await expect(copyReadableLink({ kind: "workspace", workspaceId: "ws-1" } as never, async () => true)).rejects.toThrow(
      /Readable links: not available on Canopy's server yet/,
    );
  });

  it("Request more credit explains an old server", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("Method not allowed");
    await expect(requestMoreCredit()).rejects.toThrow(/Requesting credit: not available on Canopy's server yet/);
  });
});
