// @vitest-environment jsdom
//
// The dialog's claims: it opens with a generated, editable title and body,
// regenerates on request, pushes before creating, and hands the new PR to the
// watcher. The wording rules live in prGenerate.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OpenPrDialog } from "./OpenPrDialog";
import * as ipc from "../ipc";
import * as watch from "../prWatchStore";

vi.mock("../ipc", () => ({
  gitPrContext: vi.fn(),
  gitBranches: vi.fn(),
  gitPush: vi.fn(),
  ghPrCreate: vi.fn(),
}));
vi.mock("../prWatchStore", () => ({ refresh: vi.fn() }));

const CTX = {
  branch: "feat/remote-search",
  base: "main",
  commits: ["add remote search filters"],
  commit_count: 1,
  files: ["src/search.ts"],
  file_count: 1,
  stat: "1 file changed",
  template: null,
};

const branch = (name: string, current = false) => ({
  name,
  current,
  remote_only: false,
  synced: true,
  subject: "",
  protected: false,
});

function setup(over: Partial<React.ComponentProps<typeof OpenPrDialog>> = {}) {
  const props = { open: true, repo: "/r", onNotice: vi.fn(), onClose: vi.fn(), ...over };
  render(<OpenPrDialog {...props} />);
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.gitPrContext).mockResolvedValue(CTX);
  vi.mocked(ipc.gitBranches).mockResolvedValue([
    branch("main"),
    branch("feat/remote-search", true),
  ]);
  vi.mocked(ipc.gitPush).mockResolvedValue("Pushed");
  vi.mocked(ipc.ghPrCreate).mockResolvedValue("https://github.com/o/r/pull/9");
});

describe("OpenPrDialog", () => {
  it("opens with a generated title and body the user can edit", async () => {
    setup();
    const title = (await screen.findByLabelText("Title")) as HTMLInputElement;
    await waitFor(() => expect(title.value).toBe("Add remote search filters"));
    const body = screen.getByLabelText("Description") as HTMLTextAreaElement;
    expect(body.value).toContain("## Summary");
    fireEvent.change(title, { target: { value: "My own title" } });
    expect(title.value).toBe("My own title");
  });

  it("regenerates the draft on request, discarding edits", async () => {
    setup();
    const title = (await screen.findByLabelText("Title")) as HTMLInputElement;
    await waitFor(() => expect(title.value).not.toBe(""));
    fireEvent.change(title, { target: { value: "edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(title.value).toBe("Add remote search filters"));
  });

  it("pushes, creates the PR as a draft when asked, and refreshes the watcher", async () => {
    const props = setup();
    const title = (await screen.findByLabelText("Title")) as HTMLInputElement;
    await waitFor(() => expect(title.value).not.toBe(""));
    fireEvent.click(screen.getByLabelText("Open as draft"));
    fireEvent.click(screen.getByRole("button", { name: "Open pull request" }));
    await waitFor(() => expect(ipc.ghPrCreate).toHaveBeenCalled());
    expect(ipc.gitPush).toHaveBeenCalledWith("/r", true);
    const args = vi.mocked(ipc.ghPrCreate).mock.calls[0];
    expect(args.slice(0, 3)).toEqual(["/r", "main", "feat/remote-search"]);
    expect(args[3]).toBe("Add remote search filters");
    expect(args[5]).toBe(true);
    const link = await screen.findByRole("link", { name: /pull\/9/ });
    expect(link.getAttribute("href")).toBe("https://github.com/o/r/pull/9");
    await waitFor(() => expect(watch.refresh).toHaveBeenCalled());
    expect(props.onNotice).toHaveBeenCalled();
  });

  it("keeps the dialog open and says so when the push fails", async () => {
    vi.mocked(ipc.gitPush).mockRejectedValue("rejected");
    setup();
    const title = (await screen.findByLabelText("Title")) as HTMLInputElement;
    await waitFor(() => expect(title.value).not.toBe(""));
    fireEvent.click(screen.getByRole("button", { name: "Open pull request" }));
    expect(await screen.findByText(/rejected/)).toBeTruthy();
    expect(ipc.ghPrCreate).not.toHaveBeenCalled();
  });
});
