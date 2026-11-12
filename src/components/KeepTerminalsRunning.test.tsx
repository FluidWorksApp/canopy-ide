// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKeepTerminalsRunning, type HostSetting, type KeepTerminalsDeps } from "./KeepTerminalsRunning";
import { Switch } from "./ui";

afterEach(cleanup);

function Row({ deps }: { deps: KeepTerminalsDeps }) {
  const keep = useKeepTerminalsRunning(deps);
  if (!keep.visible) return <p>hidden</p>;
  return (
    <div>
      <Switch checked={keep.on} aria-label="Keep terminals running after quit" onChange={keep.set} />
      {keep.error && <span>{keep.error}</span>}
    </div>
  );
}
const setting = (over: Partial<HostSetting> = {}): HostSetting => ({ supported: true, on: true, forced: null, ...over });

describe("Keep terminals running after quit", () => {
  it("is on by default and persists a change through the backend", async () => {
    const deps = { load: vi.fn().mockResolvedValue(setting()), save: vi.fn().mockResolvedValue(undefined) };
    render(<Row deps={deps} />);
    const toggle = await screen.findByRole("switch", { name: "Keep terminals running after quit" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(deps.save).toHaveBeenCalledWith(false));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("puts the switch back and says why when saving fails", async () => {
    const deps = { load: vi.fn().mockResolvedValue(setting()), save: vi.fn().mockRejectedValue(new Error("disk full")) };
    render(<Row deps={deps} />);
    fireEvent.click(await screen.findByRole("switch"));
    await screen.findByText("disk full");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("is hidden where terminals cannot be hosted, and when the host cannot answer", async () => {
    const win = { load: vi.fn().mockResolvedValue(setting({ supported: false, on: false })), save: vi.fn() };
    const first = render(<Row deps={win} />);
    await waitFor(() => expect(win.load).toHaveBeenCalled());
    expect(screen.queryByRole("switch")).toBeNull();
    first.unmount();
    const broken = { load: vi.fn().mockRejectedValue(new Error("no such command")), save: vi.fn() };
    render(<Row deps={broken} />);
    await waitFor(() => expect(broken.load).toHaveBeenCalled());
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("is a row in Settings → Terminal with the approved wording", () => {
    const source = readFileSync(join(process.cwd(), "src/components/SettingsDialog.tsx"), "utf8");
    const terminal = source.slice(source.indexOf('{tab === "terminal"'), source.indexOf('{tab === "spotsearch"'));
    expect(terminal).toContain('name="Keep terminals running after quit"');
    expect(terminal).toContain(
      "Terminals and agents stay alive for 2 hours after you quit or update, and reconnect on next launch. Applies after restart. Mac and Linux.",
    );
  });
});
