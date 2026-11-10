import { describe, expect, it } from "vitest";
import { isOneTimeLink } from "./AgentBrowserPip";

describe("isOneTimeLink", () => {
  it("flags links that act when loaded", () => {
    for (const url of [
      "https://app.example/auth/callback?code=abc",
      "https://x.example/verify?token=1",
      "https://x.example/reset-password",
      "https://x.example/?magic=1",
      "https://x.example/invite/abc",
    ]) expect(isOneTimeLink(url), url).toBe(true);
  });
  it("leaves ordinary pages alone", () => {
    for (const url of ["http://localhost:3000/", "https://x.example/docs?page=2", "http://127.0.0.1:5190/?source=pwa", "not a url"]) {
      expect(isOneTimeLink(url), url).toBe(false);
    }
  });
});
