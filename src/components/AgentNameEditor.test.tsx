// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentNameEditor } from "./AgentNameEditor";

const setName = vi.hoisted(() => vi.fn());
vi.mock("../ipc", () => ({ ptySetName: setName }));

describe("AgentNameEditor", () => {
  it("keeps an in-progress user edit when background stats update the name", async () => {
    const user = userEvent.setup();
    const view = render(<AgentNameEditor ptyId={8} name="Original" />);
    await user.click(screen.getByRole("button", {name:"Rename Original"}));
    const input = screen.getByRole("textbox", {name:"Agent name"});
    await user.clear(input);
    await user.type(input,"My permanent label");
    view.rerender(<AgentNameEditor ptyId={8} name="Background title" />);
    expect((input as HTMLInputElement).value).toBe("My permanent label");
    await user.type(input,"{Escape}");
  });
  it("persists an inline rename against the existing terminal credential", async () => {
    setName.mockResolvedValueOnce("Piper Prime");
    const user = userEvent.setup();
    render(<AgentNameEditor ptyId={7} name="Piper" />);
    await user.click(screen.getByRole("button", { name: "Rename Piper" }));
    const input = screen.getByRole("textbox", { name: "Agent name" });
    await user.clear(input);
    await user.type(input, "Piper Prime{Enter}");
    expect(setName).toHaveBeenCalledWith(7, "Piper Prime");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Rename Piper Prime" })).toBeTruthy(),
    );
  });
});
