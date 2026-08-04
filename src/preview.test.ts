import { describe, expect, it } from "vitest";
import {
  previewAgentTarget,
  previewFeedbackContext,
  type PreviewAnnotation,
  type PreviewServer,
} from "./preview";

const annotation = (over: Partial<PreviewAnnotation> = {}): PreviewAnnotation => ({
  n: 1,
  selector: "#save",
  tag: "button",
  id: "save",
  classes: "primary",
  text: "Save",
  html: "<button>Save</button>",
  components: ["SaveButton"],
  rect: { x: 0, y: 0, w: 100, h: 40 },
  pageUrl: "http://localhost:5173/settings",
  pageTitle: "Settings",
  comment: "Make this clearer",
  ...over,
});

describe("previewFeedbackContext", () => {
  it("only includes annotations not already sent", () => {
    const brief = previewFeedbackContext("http://localhost:5173/settings", [
      annotation({ n: 1, selector: "#old", text: "Old", sent: true }),
      annotation({ n: 2, selector: "#new", text: "New" }),
    ]);

    expect(brief).toContain("selector `#new`");
    expect(brief).not.toContain("selector `#old`");
    expect(brief).toContain("an element");
  });
});

describe("previewAgentTarget", () => {
  const targets = [
    { ptyId: 1, cwd: "/repo/web", title: "Web agent" },
    { ptyId: 2, cwd: "/repo/api", title: "API agent" },
  ];
  const server: PreviewServer = {
    url: "http://localhost:5173",
    port: 5173,
    ptyId: 10,
    title: "web",
    cwd: "/repo/web",
    componentLabel: "web",
    componentPath: "/repo/web",
    run: true,
  };

  it("keeps an explicit recipient ahead of preview ownership", () => {
    expect(previewAgentTarget(targets, 2, 1, server)?.ptyId).toBe(2);
  });

  it("defaults to the agent that initiated the preview", () => {
    expect(previewAgentTarget(targets, undefined, 2, server)?.ptyId).toBe(2);
  });

  it("falls back to an agent working in the serving component", () => {
    expect(previewAgentTarget(targets, undefined, undefined, server)?.ptyId).toBe(1);
  });
});
