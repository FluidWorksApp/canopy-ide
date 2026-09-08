// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GIB } from "../agentMemory";
import { AgentMemorySettings } from "./AgentMemorySettings";

describe("AgentMemorySettings", () => {
  it("loads and persists an allowance maximum under the agent CLI identity", async () => {
    const load = vi.fn().mockResolvedValue([
      {
        cli_key: "pkg:npm:@example/quill",
        max_allowance_bytes: 2 * GIB,
      },
    ]);
    const save = vi.fn().mockResolvedValue([
      {
        cli_key: "pkg:npm:@example/quill",
        max_allowance_bytes: 4 * GIB,
      },
    ]);
    render(
      <AgentMemorySettings
        agents={[
          {
            id: "quill",
            name: "Quill",
            bin: "/opt/quill",
            pkgs: ["npm:@example/quill"],
          },
        ]}
        load={load}
        save={save}
      />,
    );

    const select = await screen.findByRole("combobox", {
      name: "Quill maximum memory allowance",
    });
    await waitFor(() => expect(select).toHaveValue(String(2 * GIB)));
    fireEvent.change(select, { target: { value: 4 * GIB } });
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        "pkg:npm:@example/quill",
        4 * GIB,
      ),
    );
    expect(screen.getByText(/cap future allowance grants/i)).toBeTruthy();
    expect(screen.getByText(/only monitors memory/i)).toBeTruthy();
  });
});
