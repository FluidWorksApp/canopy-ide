import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../projects";
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
  it("replaces workspace tabs with a compact browser and project menu", () => {
    const active = project("app", "Storefront", true);
    const closed = project("docs", "Documentation");
    const { onOpenProject } = renderTitleBar(active, [active, closed]);

    expect(document.querySelector(".project-tabs")).toBeNull();
    expect(document.querySelector(".build-browser-location")).not.toBeNull();
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
});
