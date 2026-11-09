import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpProviderPicker } from "./AcpProviderPicker";

beforeEach(() => localStorage.clear());

describe("AcpProviderPicker", () => {
  it("adds a preset in one click", async () => {
    const onAdd = vi.fn();
    render(<AcpProviderPicker onAdd={onAdd} />);
    await userEvent.click(screen.getByRole("button", { name: "Add Gemini CLI as an ACP provider" }));
    expect(onAdd).toHaveBeenCalledWith({ name: "Gemini CLI", bin: "gemini", acp: { args: ["--acp"] } });
  });

  it("lists registry agents and adds the chosen launch", async () => {
    const body = {
      agents: [
        {
          id: "qwen",
          name: "Qwen",
          version: "1.0.0",
          distribution: { npx: { package: "@q/qwen@1.0.0", args: ["--acp"] } },
        },
      ],
    };
    const f = vi.fn(async () => new Response(JSON.stringify(body)));
    const onAdd = vi.fn();
    render(<AcpProviderPicker onAdd={onAdd} fetchImpl={f as never} />);
    await userEvent.click(screen.getByRole("button", { name: "Browse the ACP registry" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add Qwen via npx" }));
    expect(onAdd).toHaveBeenCalledWith({
      name: "Qwen",
      bin: "npx",
      acp: { args: ["-y", "@q/qwen@1.0.0", "--acp"] },
    });
  });

  it("degrades to presets when offline", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("down");
    });
    render(<AcpProviderPicker onAdd={vi.fn()} fetchImpl={f as never} />);
    await userEvent.click(screen.getByRole("button", { name: "Browse the ACP registry" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/presets still work/);
    expect(screen.getByRole("button", { name: /Add Goose/ })).toBeInTheDocument();
  });
});
