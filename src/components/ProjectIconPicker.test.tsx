import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IconFs } from "../projectIcon";
import { bytesToDataUrl } from "../projectIcon";
import type { Project } from "../projects";
import { useProjectIcons } from "../useProjectIcons";
import { ProjectIconPicker } from "./ProjectIconPicker";

const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"/>');
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** A two-file project at /work/demo-app, readable unless `blocked`. */
function fakeFs(blocked = false) {
  const files: Record<string, Uint8Array> = {
    "/work/demo-app/public/favicon.svg": SVG,
    "/work/demo-app/public/apple-touch-icon.png": PNG,
  };
  return {
    readDir: vi.fn<IconFs["readDir"]>(async (path: string) => {
      if (blocked) throw new Error("path outside workspace scope");
      if (path === "/work/demo-app") return [{ name: "public", path: "/work/demo-app/public", is_dir: true }];
      if (path === "/work/demo-app/public")
        return Object.keys(files).map((p) => ({ name: p.split("/").pop()!, path: p, is_dir: false }));
      throw new Error("No such file or directory");
    }),
    statMany: async (paths: string[]) => paths.map((path) => ({ path, size: files[path]?.length ?? 0 })),
    readFile: async (path: string) => {
      if (!files[path]) throw new Error("No such file or directory");
      return files[path];
    },
  };
}

describe("ProjectIconPicker", () => {
  it("offers auto, the icons found in the project, built-ins, a file and none", async () => {
    const onChange = vi.fn();
    render(<ProjectIconPicker roots={["/work/demo-app"]} value={undefined} onChange={onChange} fs={fakeFs()} />);
    await screen.findByText(/Auto uses public\/favicon\.svg/);
    expect(screen.getByRole("radio", { name: "Auto" })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("radio", { name: "public/apple-touch-icon.png" }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: "path", path: "/work/demo-app/public/apple-touch-icon.png" });
    fireEvent.click(screen.getByRole("radio", { name: "🚀" }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: "emoji", emoji: "🚀" });
    fireEvent.click(screen.getByRole("radio", { name: "None" }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: "none" });
    fireEvent.click(screen.getByRole("radio", { name: "Auto" }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByRole("radio", { name: "Choose image…" })).toBeTruthy();
  });

  it("turns a picked image file into an inline icon", async () => {
    const onChange = vi.fn();
    render(<ProjectIconPicker roots={["/work/demo-app"]} value={undefined} onChange={onChange} fs={fakeFs()} />);
    const input = screen.getByLabelText("Image file") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([PNG], "logo.png", { type: "image/png" })] } });
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({ kind: "image", dataUrl: bytesToDataUrl(PNG, "image/png") }),
    );
    fireEvent.change(input, { target: { files: [new File(["just text"], "notes.png")] } });
    expect(await screen.findByText("Not an image Canopy can show.")).toBeTruthy();
  });

  it("marks the current choice and still works when the folders are out of reach", async () => {
    render(
      <ProjectIconPicker roots={["/work/demo-app"]} value={{ kind: "emoji", emoji: "🌲" }} onChange={() => {}} fs={fakeFs(true)} />,
    );
    await screen.findByText(/No icon found/);
    expect(screen.getByRole("radio", { name: "🌲" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("useProjectIcons", () => {
  beforeEach(() => localStorage.clear());
  const demo = (over: Partial<Project> = {}): Project => ({
    id: "demo",
    name: "Demo App",
    components: [{ id: "c1", label: "demo-app", path: "/work/demo-app" }],
    ...over,
  });

  it("loads the detected icon for an open project", async () => {
    const projects = [demo()];
    const { result } = renderHook(() => useProjectIcons(projects, {}, fakeFs()));
    await waitFor(() => expect(result.current.demo).toBe(bytesToDataUrl(SVG, "image/svg+xml")));
  });

  it("does not touch a sleeping project's folders, but shows its remembered icon", async () => {
    const fs = fakeFs();
    const projects = [demo()];
    const first = renderHook(() => useProjectIcons(projects, {}, fs));
    await waitFor(() => expect(first.result.current.demo).toBeTruthy());
    first.unmount();
    fs.readDir.mockClear();

    const asleep = { demo: {} };
    const { result } = renderHook(() => useProjectIcons(projects, asleep, fs));
    expect(result.current.demo).toBe(bytesToDataUrl(SVG, "image/svg+xml"));
    expect(fs.readDir).not.toHaveBeenCalled();
  });

  it("keeps a remembered icon while the folders can't be read yet, then picks up the real one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const chosen = demo({ icon: { kind: "path", path: "/work/demo-app/public/apple-touch-icon.png" } });
      const projects = [chosen];
      const ok = renderHook(() => useProjectIcons(projects, {}, fakeFs()));
      await waitFor(() => expect(ok.result.current.demo).toBe(bytesToDataUrl(PNG, "image/png")));
      ok.unmount();

      // Next start: scope not registered yet, so the first lookups can't look.
      let blocked = true;
      const live = fakeFs();
      const realReadDir = live.readDir.getMockImplementation()!;
      live.readDir.mockImplementation(async (path: string) => {
        if (blocked) throw new Error("path outside workspace scope");
        return realReadDir(path);
      });
      const { result } = renderHook(() => useProjectIcons(projects, {}, live));
      expect(result.current.demo).toBe(bytesToDataUrl(PNG, "image/png"));
      await waitFor(() => expect(live.readDir).toHaveBeenCalled());
      expect(result.current.demo).toBe(bytesToDataUrl(PNG, "image/png"));
      blocked = false;
      await vi.advanceTimersByTimeAsync(2500);
      await waitFor(() => expect(live.readDir.mock.calls.length).toBeGreaterThan(1));
      expect(result.current.demo).toBe(bytesToDataUrl(PNG, "image/png"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips file lookups when the user chose a glyph, an image or none", async () => {
    const fs = fakeFs();
    const projects = [demo({ icon: { kind: "emoji", emoji: "🚀" } })];
    const { result } = renderHook(() => useProjectIcons(projects, {}, fs));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.demo).toBeUndefined();
    expect(fs.readDir).not.toHaveBeenCalled();
  });
});
