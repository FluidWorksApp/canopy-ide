// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentNameEditor } from "./AgentNameEditor";

const setName = vi.hoisted(() => vi.fn());
vi.mock("../ipc", () => ({ ptySetName: setName }));

describe("AgentNameEditor", () => {
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
