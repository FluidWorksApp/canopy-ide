import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getSettings } from "../settings";
import { mockCommands } from "../test/setup";
import { currentPlatform, format } from "../shortcuts";
import { Onboarding } from "./Onboarding";

vi.mock("../shortcuts", async (orig) => {
  const real = await orig<typeof import("../shortcuts")>();
  return { ...real, currentPlatform: vi.fn(() => "macos") };
});

// A project is open to host the install terminal.
vi.mock("../brainConnect", async (orig) => ({
  ...(await orig<typeof import("../brainConnect")>()),
  startBrainInstall: vi.fn(() => true),
}));

const MODEL = {
  id: "parakeet",
  name: "Parakeet v3",
  languages: ["en"],
  size_mb: 640,
  downloaded: false,
  multilingual: false,
  is_default: true,
};

/** What the OS says; a test changes it and refocuses the window. */
let os: {
  desk: { screen: boolean; input: boolean };
  privacy: { full_disk: string; microphone: string };
};
const opened: string[] = [];

const go = (user: ReturnType<typeof userEvent.setup>, n: number, title: RegExp) =>
  user.click(screen.getByRole("button", { name: new RegExp(`^Step ${n}: `) })).then(() => screen.findByRole("heading", { name: title }));

describe("Onboarding", () => {
  beforeEach(() => {
    localStorage.clear();
    opened.length = 0;
    vi.mocked(currentPlatform).mockReturnValue("macos");
    os = { desk: { screen: false, input: true }, privacy: { full_disk: "denied", microphone: "unasked" } };
    mockCommands({
      // No agent CLI installed.
      which_check: () => ({}),
      desk_permissions: () => os.desk,
      privacy_status: () => os.privacy,
      desk_request_permission: (args: { kind: string }) => void opened.push(args.kind),
      privacy_open_settings: (args: { kind: string }) => void opened.push(args.kind),
      dictation_models: () => [MODEL],
    });
  });

  it("opens on the welcome and walks forward with Enter", async () => {
    const user = userEvent.setup();
    render(<Onboarding onClose={vi.fn()} onCreateProject={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Welcome to Canopy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Get started/ })).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "Connect your agent" })).toBeInTheDocument();
    // Nothing installed in this test: the step offers an install, not a dead end.
    expect((await screen.findAllByRole("button", { name: /^Install / })).length).toBeGreaterThan(0);
    // And it never blocks: Continue is there without an agent.
    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "Make it yours" })).toBeInTheDocument();
  });

  it("steps aside for an install terminal and comes back to the same step", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Onboarding onClose={onClose} onCreateProject={vi.fn()} />);
    await go(user, 2, /Connect your agent/);

    await user.click((await screen.findAllByRole("button", { name: /^Install / }))[0]);
    // Out of the way, not finished: the terminal behind it is reachable.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    // And Esc belongs to the app while it is aside.
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Continue setup" }));
    expect(screen.getByRole("heading", { name: "Connect your agent" })).toBeInTheDocument();
  });

  it("skips from any step, by button or Esc", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Onboarding onClose={onClose} onCreateProject={vi.fn()} />);
    await go(user, 4, /Permissions/);
    await user.click(screen.getByRole("button", { name: /Skip setup/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("saves each choice as it is made, and Back keeps them", async () => {
    const user = userEvent.setup();
    render(<Onboarding onClose={vi.fn()} onCreateProject={vi.fn()} />);
    await go(user, 3, /Make it yours/);

    expect(screen.getByRole("radio", { name: "I'm an engineer" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "I build with AI" }));
    await user.click(screen.getByRole("radio", { name: "VS Code" }));
    await user.click(within(screen.getByRole("radiogroup", { name: "Look" })).getByRole("radio", { name: "Daylight" }));

    expect(getSettings()).toMatchObject({ defaultProjectLens: "build", keymapProfile: "vscode", theme: "daylight" });
    expect(document.documentElement.dataset.theme).toBe("daylight");

    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: /Continue/ }));
    expect(screen.getByRole("radio", { name: "I build with AI" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "VS Code" })).toBeChecked();
  });

  it("moves a choice with the arrow keys, and Enter on a choice continues", async () => {
    const user = userEvent.setup();
    render(<Onboarding onClose={vi.fn()} onCreateProject={vi.fn()} />);
    await go(user, 3, /Make it yours/);

    screen.getByRole("radio", { name: "I'm an engineer" }).focus();
    await user.keyboard("{ArrowUp}");
    expect(getSettings().defaultProjectLens).toBe("build");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "Permissions" })).toBeInTheDocument();
  });

  it("previews the picked shortcut profile for this platform", async () => {
    const user = userEvent.setup();
    render(<Onboarding onClose={vi.fn()} onCreateProject={vi.fn()} />);
    await go(user, 3, /Make it yours/);

    expect(screen.getByText(format("quick-open", "macos", "canopy"))).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "JetBrains" }));
    expect(screen.getByText(format("quick-open", "macos", "jetbrains"))).toBeInTheDocument();
    expect(screen.getByText(/Shown for macOS/)).toHaveAttribute("data-shortcut-platform");
  });

  it("shows each permission as the OS reports it, never allowed unchecked", async () => {
    const user = userEvent.setup();
    render(<Onboarding onClose={vi.fn()} onCreateProject={vi.fn()} />);
    await go(user, 4, /Permissions/);
    const row = (name: string) => screen.getByText(name).closest("li")!;

    expect(await within(row("Control this computer")).findByText("Allowed")).toBeInTheDocument();
    expect(within(row("Screen recording")).getByRole("button", { name: "Grant: Screen recording" })).toBeInTheDocument();
    expect(within(row("Full disk access")).getByRole("button", { name: "Grant: Full disk access" })).toBeInTheDocument();
    // Not asked yet: macOS asks on first dictation; there is nothing to open.
    expect(within(row("Microphone")).getByText("Asked on first use")).toBeInTheDocument();
    // Nothing checks notifications, so the row offers the page and claims nothing.
    expect(within(row("Notifications")).queryByText("Allowed")).toBeNull();
    await user.click(within(row("Notifications")).getByRole("button", { name: "Open Settings: Notifications" }));
    expect(opened).toEqual(["notifications"]);
  });

  it("re-reads when the window comes back, and says a restart may be needed", async () => {
    const user = userEvent.setup();
    render(<Onboarding onClose={vi.fn()} onCreateProject={vi.fn()} />);
    await go(user, 4, /Permissions/);
    const row = (name: string) => screen.getByText(name).closest("li")!;

    await user.click(await within(row("Screen recording")).findByRole("button", { name: "Grant: Screen recording" }));
    await user.click(within(row("Full disk access")).getByRole("button", { name: "Grant: Full disk access" }));
    expect(opened).toEqual(["screen", "full_disk"]);

    // Full disk now reads granted; screen recording still reads off until a restart.
    os.privacy = { ...os.privacy, full_disk: "granted" };
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await within(row("Full disk access")).findByText("Allowed")).toBeInTheDocument();
    expect(within(row("Screen recording")).getByText(/Restart Canopy/)).toBeInTheDocument();
  });

  it("offers the voice model, and only that where the OS gates nothing", async () => {
    vi.mocked(currentPlatform).mockReturnValue("windows");
    const user = userEvent.setup();
    render(<Onboarding onClose={vi.fn()} onCreateProject={vi.fn()} />);
    await go(user, 4, /Permissions/);

    expect(await screen.findByRole("button", { name: "Download Parakeet v3" })).toBeInTheDocument();
    expect(screen.queryByText("Full disk access")).toBeNull();
    expect(screen.getByText("This computer asks for nothing up front.")).toBeInTheDocument();
  });

  it("ends on creating a project, or looking around first", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onCreateProject = vi.fn();
    render(<Onboarding onClose={onClose} onCreateProject={onCreateProject} />);
    await go(user, 5, /You're set/);

    await user.click(screen.getByRole("button", { name: /Create a project/ }));
    expect(onCreateProject).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Look around first" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
