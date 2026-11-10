import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpProviderPicker } from "./AcpProviderPicker";

beforeEach(() => localStorage.clear());

const registry = (agents: unknown[]) => vi.fn(async () => new Response(JSON.stringify({ agents })));
const qwen = {
  id: "qwen",
  name: "Qwen",
  version: "1.0.0",
  icon: "https://cdn.agentclientprotocol.com/registry/v1/latest/qwen.svg",
  distribution: { npx: { package: "@q/qwen@1.0.0", args: ["--acp"] } },
};

async function openMenu() {
  await userEvent.click(screen.getByRole("button", { name: /Add an ACP connector/ }));
}

describe("AcpProviderPicker", () => {
  it("adds a verified preset in one click, with its registry icon", async () => {
    const onAdd = vi.fn();
    render(<AcpProviderPicker onAdd={onAdd} fetchImpl={registry([]) as never} />);
    await openMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: "Add Gemini CLI as an ACP provider" }));
    expect(onAdd).toHaveBeenCalledWith({
      name: "Gemini CLI",
      bin: "gemini",
      acp: { args: ["--acp"] },
      icon: "https://cdn.agentclientprotocol.com/registry/v1/latest/gemini.svg",
    });
  });

  it("lists registry connectors in the dropdown and confirms exactly what will run", async () => {
    const onAdd = vi.fn();
    render(<AcpProviderPicker onAdd={onAdd} fetchImpl={registry([qwen]) as never} />);
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Add Qwen from the ACP registry" }));
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByText("npx -y @q/qwen@1.0.0 --acp")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add Qwen" }));
    expect(onAdd).toHaveBeenCalledWith({
      name: "Qwen",
      bin: "npx",
      acp: { args: ["-y", "@q/qwen@1.0.0", "--acp"] },
      icon: "https://cdn.agentclientprotocol.com/registry/v1/latest/qwen.svg",
    });
  });

  it("asks how to run a connector that has several launch kinds", async () => {
    const multi = {
      ...qwen,
      distribution: {
        npx: { package: "@q/qwen@1.0.0", args: ["--acp"] },
        uvx: { package: "qwen==1.0.0", args: ["--acp"] },
      },
    };
    render(<AcpProviderPicker onAdd={vi.fn()} fetchImpl={registry([multi]) as never} />);
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Add Qwen from the ACP registry" }));
    expect(screen.getByRole("button", { name: "Add Qwen via npx" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Qwen via uvx" })).toBeInTheDocument();
  });

  it("degrades to the verified presets when offline", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("down");
    });
    render(<AcpProviderPicker onAdd={vi.fn()} fetchImpl={f as never} />);
    await openMenu();
    expect(await screen.findByText(/presets still work/)).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Add Goose/ })).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    render(<AcpProviderPicker onAdd={vi.fn()} fetchImpl={registry([]) as never} />);
    await openMenu();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
