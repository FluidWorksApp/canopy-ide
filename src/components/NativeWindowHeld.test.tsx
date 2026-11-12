import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NativeWindowHeld } from "./NativeWindowHeld";
import { ContextMenu } from "./ContextMenu";
import { handoverMenuItem, type HandoverStatus } from "../nativeTerm";

const show = (state: Parameters<typeof NativeWindowHeld>[0]["state"], over = {}) => {
  const props = {
    state,
    onTakeBack: vi.fn().mockResolvedValue(null),
    onClose: vi.fn(),
    ...over,
  };
  render(<NativeWindowHeld {...props} />);
  return props;
};

describe("NativeWindowHeld", () => {
  it("says the terminal is open in a native window and offers Take back", async () => {
    const { onTakeBack } = show("in_window");
    expect(screen.getByRole("status")).toHaveTextContent("Open in native window");
    await userEvent.click(screen.getByRole("button", { name: "Take back" }));
    expect(onTakeBack).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Close tab" })).not.toBeInTheDocument();
  });

  it("after the window is closed, says the terminal still runs and still offers Take back", () => {
    show("detached");
    expect(screen.getByRole("status")).toHaveTextContent("The native window was closed");
    expect(screen.getByRole("status")).toHaveTextContent("still running");
    expect(screen.getByRole("button", { name: "Take back" })).toBeEnabled();
  });

  it("when the host does not answer, says so and keeps Take back", () => {
    show("unreachable");
    expect(screen.getByRole("status")).toHaveTextContent("Open in native window");
    expect(screen.getByRole("status")).toHaveTextContent("not answering");
    expect(screen.getByRole("button", { name: "Take back" })).toBeInTheDocument();
  });

  it("an ended terminal cannot be taken back, only closed", async () => {
    const { onClose, onTakeBack } = show("ended");
    expect(screen.getByRole("status")).toHaveTextContent("ended");
    expect(screen.queryByRole("button", { name: "Take back" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close tab" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onTakeBack).not.toHaveBeenCalled();
  });

  it("shows why a take back failed and lets it be tried again", async () => {
    const onTakeBack = vi
      .fn()
      .mockResolvedValueOnce("The terminal has ended, so there is nothing to take back.")
      .mockResolvedValueOnce(null);
    show("in_window", { onTakeBack });
    await userEvent.click(screen.getByRole("button", { name: "Take back" }));
    expect(await screen.findByText(/nothing to take back/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Take back" }));
    expect(onTakeBack).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/nothing to take back/)).not.toBeInTheDocument();
  });

  it("is not stuck busy when the command itself rejects", async () => {
    const onTakeBack = vi.fn().mockRejectedValue(new Error("host went away"));
    show("detached", { onTakeBack });
    await userEvent.click(screen.getByRole("button", { name: "Take back" }));
    expect(await screen.findByText("host went away")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take back" })).toBeEnabled();
  });
});

const labels = () => [...document.querySelectorAll(".ctx-label")].map((el) => el.textContent);

describe("the terminal tab menu", () => {
  const menu = (status: HandoverStatus, available = true) => {
    const entry = handoverMenuItem({ available, status, ptyId: 4, onOpen: vi.fn() });
    render(
      <ContextMenu
        x={10}
        y={10}
        onClose={() => {}}
        items={[
          { label: "Rename" },
          ...(entry ? [entry] : []),
          { label: "Close", danger: true },
        ]}
      />,
    );
  };

  it("lists Open in Native Window between Rename and Close for a hosted terminal", () => {
    menu({ candidates: [4], handed: [] });
    expect(labels()).toEqual(["Rename", "Open in Native Window", "Close"]);
  });

  it("leaves it out when the terminal is not hosted", () => {
    menu({ candidates: [], handed: [] });
    expect(screen.queryByText("Open in Native Window")).not.toBeInTheDocument();
    expect(labels()).toEqual(["Rename", "Close"]);
  });

  it("leaves it out where the build has no native terminal", () => {
    menu({ candidates: [4], handed: [] }, false);
    expect(screen.queryByText("Open in Native Window")).not.toBeInTheDocument();
  });
});
