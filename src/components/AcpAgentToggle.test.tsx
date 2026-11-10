import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpAgentToggle } from "./AcpAgentToggle";

beforeEach(() => localStorage.clear());

describe("AcpAgentToggle", () => {
  it("is on by default for a migrated agent and turns it off", async () => {
    const onChange = vi.fn();
    render(<AcpAgentToggle cliId="claude" name="Claude Code" value={undefined} onChange={onChange} />);
    const box = screen.getByRole("checkbox", { name: "Use ACP for Claude Code" });
    expect(box).toBeChecked();
    await userEvent.click(box);
    expect(onChange).toHaveBeenCalledWith("claude", false);
  });

  it("shows off when the stored value is false", () => {
    render(<AcpAgentToggle cliId="codex" name="Codex" value={false} onChange={vi.fn()} />);
    expect(screen.getByRole("checkbox", { name: "Use ACP for Codex" })).not.toBeChecked();
  });

  it("renders nothing for an agent without an ACP entrypoint", () => {
    const { container } = render(<AcpAgentToggle cliId="aider" name="Aider" value={undefined} onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
