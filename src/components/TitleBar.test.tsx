import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../projects";
import {
  publishVibePreviewContext,
  removeVibePreviewContext,
  type VibePreviewContext,
} from "../vibePreviewContext";
import { TitleBar } from "./TitleBar";

const project = (id: string, name: string, build = false): Project => ({
  id,
  name,
  components: [],
  vibe: build ? { version: 1, enabled: true } : undefined,
});

const renderTitleBar = (active: Project, projects: Project[]) => {
  const onOpenProject = vi.fn();
  const onSelectProject = vi.fn();
  render(
    <TitleBar
      projects={projects}
      openProjects={[active]}
      activeId={active.id}
      pendingCount={() => 0}
      collabActive
      tabDragId={null}
      tabDragOffsetX={0}
      tabDragItemProps={(id) => ({
        "data-drag-id": id,
        onPointerDown: () => {},
      })}
      hibernated={{}}
      showHints={false}
      notifCount={2}
      notifUrgency="high"
      onOpenNotifications={() => {}}
      onOpenProject={onOpenProject}
      onSelectProject={onSelectProject}
      onCloseProject={() => {}}
      onHibernateProject={() => {}}
      onWakeProject={() => {}}
      onToggleVibe={() => {}}
      onEditProject={() => {}}
      onStopCollab={() => {}}
      onNewProject={() => {}}
      onManageProjects={() => {}}
    />,
  );
  return { onOpenProject, onSelectProject };
};

describe("TitleBar Build shell", () => {
  it("keeps the Build title bar quiet until a preview page exists", () => {
    const active = project("app", "Storefront", true);
    const closed = project("docs", "Documentation");
    const { onOpenProject } = renderTitleBar(active, [active, closed]);

    expect(document.querySelector(".project-tabs")).toBeNull();
    expect(document.querySelector(".build-browser-controls")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Preview address" })).toBeNull();
    expect(document.querySelector(".collab-live")).toBeNull();
    expect(screen.getByRole("button", { name: "Switch to Engineer mode" })).toBeTruthy();

    const bell = screen.getByRole("button", { name: "Notifications" });
    expect(bell.className).toContain("notif-bell-low");

    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    fireEvent.click(screen.getByText("Documentation"));
    expect(onOpenProject).toHaveBeenCalledWith("docs");
  });

  it("keeps the full project tab shelf in Engineer mode", () => {
    const active = project("app", "Storefront");
    renderTitleBar(active, [active]);

    expect(document.querySelector(".project-tabs")).not.toBeNull();
    expect(document.querySelector(".build-browser-location")).toBeNull();
    expect(document.querySelector(".collab-live")).not.toBeNull();
  });

  it("hosts the active Build preview controls without a second browser bar", () => {
    const go = vi.fn();
    const navigate = vi.fn();
    const togglePicking = vi.fn();
    const capture = vi.fn();
    const context: VibePreviewContext = {
      projectId: "app",
      tabId: "preview",
      url: "http://localhost:4321/products",
      server: null,
      annotations: [],
      shots: [],
      picking: false,
      capturing: false,
      captureMode: "visible",
      go,
      navigate,
      togglePicking,
      capture,
      setAnnotationComment: vi.fn(),
      removeAnnotation: vi.fn(),
      clearAnnotations: vi.fn(),
      setShotNote: vi.fn(),
      removeShot: vi.fn(),
      clearShots: vi.fn(),
      markSent: vi.fn(),
    };
    publishVibePreviewContext(context);
    renderTitleBar(project("app", "Storefront", true), [project("app", "Storefront", true)]);

    expect(screen.queryByText("Live preview")).toBeNull();
    const address = screen.getByRole("textbox", { name: "Preview address" });
    expect(address).toHaveValue("http://localhost:4321/products");
    fireEvent.click(screen.getByTitle("Back"));
    fireEvent.click(screen.getByTitle("Reload"));
    fireEvent.click(screen.getByRole("button", { name: "Annotate page" }));
    fireEvent.click(screen.getByRole("button", { name: "Capture screenshot" }));
    expect(go).toHaveBeenNthCalledWith(1, -1);
    expect(go).toHaveBeenNthCalledWith(2, 0);
    expect(togglePicking).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("visible");

    fireEvent.click(screen.getByRole("button", { name: "Choose capture type" }));
    fireEvent.click(screen.getByText("Select a region…"));
    expect(capture).toHaveBeenCalledWith("region");

    fireEvent.change(address, { target: { value: "http://localhost:4321/cart" } });
    fireEvent.submit(address.closest("form")!);
    expect(navigate).toHaveBeenCalledWith("http://localhost:4321/cart");
    removeVibePreviewContext("app", "preview");
  });

  it("centres live preview controls on the title bar itself", () => {
    const css = readFileSync(join(process.cwd(), "src/index.css"), "utf8");
    expect(css).toMatch(/\.titlebar-build\s*{[^}]*position:\s*relative;/s);
    expect(css).toMatch(
      /\.build-browser-controls\s*{[^}]*position:\s*absolute;[^}]*left:\s*50%;[^}]*transform:\s*translateX\(-50%\);/s,
    );
  });
});
