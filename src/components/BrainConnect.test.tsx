import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../brainStatus", () => {
  let state: Record<string, unknown> = { state: "unknown", cli: null, label: null, checkedAt: null };
  const subs = new Set<() => void>();
  return {
    brainConnection: () => state,
    checkBrainConnection: vi.fn(async () => state),
    subscribeBrainConnection: (cb: () => void) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    __set: (next: Record<string, unknown>) => {
      state = next;
      subs.forEach((cb) => cb());
    },
  };
});

import * as status from "../brainStatus";
import { mockCommands } from "../test/setup";
import { agentCliFor } from "../projects";
import { getSettings, updateSettings } from "../settings";
import { BrainConnectHost, BrainConnectPanel, ConnectBrainCta } from "./BrainConnect";
import { OPEN_BRAIN_CONNECT_EVENT } from "../brainConnect";

const setState = (status as unknown as { __set: (s: Record<string, unknown>) => void }).__set;
const checkMock = status.checkBrainConnection as unknown as ReturnType<typeof vi.fn>;
const claude = agentCliFor("claude")!;
const codex = agentCliFor("codex")!;

function installed(...bins: string[]) {
  mockCommands({ which_check: () => Object.fromEntries(bins.map((b) => [b, true])) });
}

beforeEach(() => {
  localStorage.clear();
  checkMock.mockClear();
  updateSettings({ defaultAgent: claude.id });
  setState({ state: "unknown", cli: null, label: null, checkedAt: null });
});

describe("BrainConnectPanel", () => {
  it("lists installed brains, recommends one and checks it on arrival", async () => {
    installed(claude.bin, codex.bin);
    render(<BrainConnectPanel />);
    const picker = await screen.findByRole("combobox", { name: "Brain" });
    expect(picker).toHaveValue(claude.id);
    expect(screen.getByRole("option", { name: codex.name })).toBeInTheDocument();
    await waitFor(() => expect(checkMock).toHaveBeenCalledTimes(1));
  });

  it("switching brains stores the choice and checks again", async () => {
    installed(claude.bin, codex.bin);
    render(<BrainConnectPanel />);
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Brain" }), codex.id);
    expect(getSettings().defaultAgent).toBe(codex.id);
    expect(checkMock).toHaveBeenCalled();
  });

  it("never shows another CLI's result under the selected brain", async () => {
    installed(claude.bin, codex.bin);
    setState({ state: "error", cli: codex.id, label: codex.name, checkedAt: 1, message: "model_not_found" });
    render(<BrainConnectPanel />);
    await screen.findByRole("combobox", { name: "Brain" });
    expect(screen.queryByText(/model_not_found/)).not.toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`${codex.name} did not answer`))).not.toBeInTheDocument();
    await waitFor(() => expect(checkMock).toHaveBeenCalled());
  });

  it("shows connected with the model pickers", async () => {
    installed(claude.bin);
    setState({ state: "connected", cli: claude.id, label: claude.name, checkedAt: 1 });
    render(<BrainConnectPanel />);
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    const main = await screen.findByLabelText("Main model");
    expect(screen.getByLabelText("Background model")).toBeInTheDocument();
    const option = main.querySelectorAll("option")[1] as HTMLOptionElement;
    await userEvent.selectOptions(main, option.value);
    expect(getSettings().brainModel).toBe(option.value);
  });

  it("signed out: opens the CLI's sign-in in a terminal and closes the host", async () => {
    installed(claude.bin);
    setState({ state: "signed-out", cli: claude.id, label: claude.name, checkedAt: 1, message: "Not logged in" });
    const onTerminalOpened = vi.fn();
    const seen: Record<string, unknown>[] = [];
    const take = (e: Event) => {
      const d = (e as CustomEvent).detail;
      seen.push({ ...d });
      d.handled = true;
    };
    window.addEventListener("canopy:run-command", take);
    try {
      render(<BrainConnectPanel onTerminalOpened={onTerminalOpened} />);
      expect(await screen.findByText("Signed out")).toBeInTheDocument();
      expect(screen.getByText("Not logged in")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: `Sign in to ${claude.name}` }));
    } finally {
      window.removeEventListener("canopy:run-command", take);
    }
    expect(seen[0]).toMatchObject({ command: claude.bin, then: "brain-recheck" });
    expect(onTerminalOpened).toHaveBeenCalled();
  });

  it("signed out with no project open: says exactly what to run", async () => {
    installed(claude.bin);
    setState({ state: "signed-out", cli: claude.id, label: claude.name, checkedAt: 1 });
    render(<BrainConnectPanel />);
    await userEvent.click(await screen.findByRole("button", { name: `Sign in to ${claude.name}` }));
    expect(screen.getByRole("note")).toHaveTextContent(`Run \`${claude.bin}\` in a terminal`);
  });

  it("nothing installed: offers to install a brain", async () => {
    installed();
    setState({ state: "missing", cli: null, label: null, checkedAt: 1 });
    render(<BrainConnectPanel />);
    expect(await screen.findByRole("button", { name: `Install ${claude.name}` })).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    // No candidates, so nothing to check yet.
    expect(screen.queryByRole("button", { name: /check/i })).toBeNull();
  });

  it("rate-limited: explains the pause and offers a re-check", async () => {
    installed(claude.bin);
    setState({ state: "rate-limited", cli: claude.id, label: claude.name, checkedAt: 1 });
    render(<BrainConnectPanel />);
    expect(await screen.findByText("Rate-limited")).toBeInTheDocument();
    expect(screen.getByText(/files and terminals keep working/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(checkMock).toHaveBeenCalled();
  });

  it("a chosen CLI that can't be the brain: offers the recommended one", async () => {
    installed(claude.bin, agentCliFor("amp")!.bin);
    updateSettings({ defaultAgent: "amp" });
    setState({ state: "missing", cli: null, label: "Amp", checkedAt: 1 });
    render(<BrainConnectPanel />);
    await userEvent.click(await screen.findByRole("button", { name: `Use ${claude.name}` }));
    expect(getSettings().defaultAgent).toBe(claude.id);
  });
});

describe("BrainConnectPanel layout", () => {
  it("offers agents not in the list from one menu, and adds only the one picked", async () => {
    // npx is how the Copilot, Qwen and adapter presets run.
    installed(claude.bin, "npx", "gemini");
    render(<BrainConnectPanel />);
    const before = getSettings().customClis.length;

    await userEvent.click(await screen.findByRole("button", { name: "Add agent…" }));
    expect(screen.getByText("Gemini CLI")).toBeInTheDocument();
    expect(screen.getByText("GitHub Copilot CLI")).toBeInTheDocument();
    // Claude Code is already in the list: its adapter adds nothing here.
    expect(screen.queryByText("Claude (ACP adapter)")).not.toBeInTheDocument();
    // Opening the menu adds nothing.
    expect(getSettings().customClis.length).toBe(before);

    await userEvent.click(screen.getByText("Gemini CLI"));
    const rows = getSettings().customClis;
    expect(rows.length).toBe(before + 1);
    expect(getSettings().defaultAgent).toBe(rows[rows.length - 1].id);
  });

  it("has one re-check, on the status line", async () => {
    installed(claude.bin);
    setState({ state: "connected", cli: claude.id, label: claude.name, checkedAt: 1 });
    render(<BrainConnectPanel />);
    const check = await screen.findByRole("button", { name: "Check again" });
    expect(check.closest('[role="status"]')).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /Check/ })).toHaveLength(1);
  });

  it("nothing installed: one install, the rest behind one menu", async () => {
    installed();
    setState({ state: "missing", cli: null, label: null, checkedAt: 1 });
    render(<BrainConnectPanel />);
    expect(await screen.findAllByRole("button", { name: /^Install / })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Another agent…" }));
    expect((await screen.findAllByText(/^Install /)).length).toBeGreaterThan(1);
  });
});

describe("Connect your brain entry points", () => {
  it("the call to action and the host open one dialog", async () => {
    installed(claude.bin);
    setState({ state: "missing", cli: null, label: null, checkedAt: 1 });
    render(
      <>
        <ConnectBrainCta what="Suggesting a commit message" />
        <BrainConnectHost />
      </>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Connect your brain" }));
    expect(await screen.findByRole("dialog", { name: "Connect your brain" })).toBeInTheDocument();
    act(() => window.dispatchEvent(new Event(OPEN_BRAIN_CONNECT_EVENT)));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
});
