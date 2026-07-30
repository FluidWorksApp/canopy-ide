// Where a clicked link goes, and the one rule that matters more than the
// destination: it always goes somewhere.
import { beforeEach, describe, expect, it, vi } from "vitest";

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { OPEN_URL_EVENT, openLink } from "./links";
import { updateSettings } from "./settings";

/** Stand in for a project view that is in front and takes the URL. */
function claimUrls(): { urls: string[]; stop: () => void } {
  const urls: string[] = [];
  const on = (e: Event) => {
    urls.push((e as CustomEvent<{ url: string }>).detail.url);
    e.preventDefault();
  };
  window.addEventListener(OPEN_URL_EVENT, on);
  return { urls, stop: () => window.removeEventListener(OPEN_URL_EVENT, on) };
}

/** The dynamic import inside openLink resolves on a microtask. */
const settled = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  openUrl.mockClear();
  updateSettings({ openLinksInApp: true });
});

describe("openLink", () => {
  it("hands the url to a view that claims it, and does not leave the app", async () => {
    const claimed = claimUrls();
    openLink("https://example.com/docs");
    await settled();
    expect(claimed.urls).toEqual(["https://example.com/docs"]);
    expect(openUrl).not.toHaveBeenCalled();
    claimed.stop();
  });

  it("falls back to the OS browser when nobody claims it", async () => {
    // No project open, or none in front. A click that does nothing at all is
    // the one outcome worse than opening in the wrong place.
    openLink("https://example.com/docs");
    await settled();
    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("goes straight out when the setting is off, without asking any view", async () => {
    updateSettings({ openLinksInApp: false });
    const claimed = claimUrls();
    openLink("https://example.com/docs");
    await settled();
    expect(claimed.urls).toEqual([]);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
    claimed.stop();
  });

  it("refuses every scheme but http(s), rather than forwarding it", async () => {
    // A `javascript:` or `file:` href in an issue body or a converted document
    // is a script execution or a local read. Neither destination gets asked.
    const claimed = claimUrls();
    for (const href of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>1</script>",
      "canopy://open",
      "/relative/path",
      "",
    ]) {
      openLink(href);
    }
    await settled();
    expect(claimed.urls).toEqual([]);
    expect(openUrl).not.toHaveBeenCalled();
    claimed.stop();
  });

  it("takes http as well as https", async () => {
    // localhost dev servers are the common case and are rarely https.
    const claimed = claimUrls();
    openLink("http://localhost:4321/");
    await settled();
    expect(claimed.urls).toEqual(["http://localhost:4321/"]);
    claimed.stop();
  });
});
