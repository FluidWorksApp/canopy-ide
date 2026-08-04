// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReleaseNotesToast, UpdateToast } from "./Toast";

describe("release note surfaces", () => {
  it("shows structured highlights and opens the full release", () => {
    let opened = false;
    render(
      <ReleaseNotesToast
        release={{ version: "0.3.4", notes: "## New\n- Better previews\n- Safer updates" }}
        onOpen={() => { opened = true; }}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText("Canopy 0.3.4")).toBeInTheDocument();
    expect(screen.getByText("Better previews")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Read the full release/));
    expect(opened).toBe(true);
  });

  it("keeps raw markdown out of the update prompt", () => {
    render(
      <UpdateToast
        update={{ kind: "auto", info: { version: "0.3.4", notes: "## Raw markdown" } }}
        progress={null}
        onOpenDownloads={() => {}}
        onInstall={() => {}}
        onOpenReleaseNotes={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.queryByText("## Raw markdown")).not.toBeInTheDocument();
    expect(screen.getByText(/Review what changed/)).toBeInTheDocument();
  });
});
