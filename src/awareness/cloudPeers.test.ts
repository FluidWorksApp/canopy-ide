import { describe, expect, it } from "vitest";
import { cloudPeersFor, repoKey } from "./cloudPeers";

describe("repoKey", () => {
  it("spells every clone URL of a repository the same way", () => {
    for (const url of ["git@github.com:Acme/api.git", "https://user@github.com/acme/api", "ssh://git@github.com:22/acme/api.git", "https://github.com/acme/api/"])
      expect(repoKey(url)).toBe("github.com/acme/api");
    expect(repoKey("")).toBeNull();
    expect(repoKey("/local/path")).toBeNull();
    expect(repoKey(null)).toBeNull();
  });
});

describe("cloudPeersFor", () => {
  it("keeps online agents on the repository, with relative files only", () => {
    const peers = cloudPeersFor(
      [
        { id: "w", name: "cloud", online: true, agents: [{ ptyId: 3, name: null, agent: "x", task: "t", repo: "git@github.com:acme/api.git", root: "/workspace/api", files: [{ path: "a.ts", ts: 5 }, { path: "/etc/passwd", ts: 6 }] }] },
        { id: "off", name: "stopped", online: false, agents: null },
      ],
      "github.com/acme/api",
    );
    expect(peers).toEqual([
      expect.objectContaining({ sessionId: "cloud:w:3", ptyId: 3, name: "x in cloud", files: ["a.ts"], recent: [{ path: "a.ts", ts: 5 }], cloud: { workspace: "w", workspaceName: "cloud", root: "/workspace/api" } }),
    ]);
  });
});
