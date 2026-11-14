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

const renderTitleBar = (active: Project, projects: Project[], collabActive = true) => {
  const onOpenProject = vi.fn();
  const onSelectProject = vi.fn();
  const { unmount } = render(
    <TitleBar
      projects={projects}
      openProjects={[active]}
      activeId={active.id}
      pendingCount={() => 0}
      collabActive={collabActive}
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
      onTogglePinProject={() => {}}
      onWakeProject={() => {}}
      onToggleVibe={() => {}}
      onEditProject={() => {}}
      onStopCollab={() => {}}
      onNewProject={() => {}}
      onManageProjects={() => {}}
    />,
  );
  return { onOpenProject, onSelectProject, unmount };
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
    expect(screen.getByRole("button", { name: "Switch to the Engineer lens" })).toBeTruthy();

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

describe("TitleBar lens switch placement", () => {
  // The switch must not jump when toggled: both lenses render it from the same
  // trailing slot, followed by the same controls, and that slot is pinned to
  // the right edge regardless of what (if anything) fills the bar before it.
  const trailingLayout = (build: boolean) => {
    const active = project("app", "Storefront", build);
    const { unmount } = renderTitleBar(active, [active], false);
    const toggle = screen.getByRole("button", { name: /Switch to the .* lens/ });
    const slot = toggle.closest(".titlebar-context");
    expect(slot).not.toBeNull();
    expect(slot!.parentElement!.classList.contains("titlebar")).toBe(true);
    expect(slot!.lastElementChild).toBe(toggle);
    const after: string[] = [];
    for (let el = slot!.nextElementSibling; el; el = el.nextElementSibling) {
      if (el.classList.contains("notif-bell")) after.push("bell");
      else if (el.matches(".build-project-menu, .project-manage-btn")) after.push("projects");
      else after.push(el.className);
    }
    unmount();
    return after;
  };

  it("renders the switch in the same slot and order in Builder and Engineer", () => {
    const builder = trailingLayout(true);
    const engineer = trailingLayout(false);
    expect(builder).toEqual(["bell", "projects"]);
    expect(engineer).toEqual(builder);
  });

  it("pins the switch slot to the right edge of the title bar", () => {
    const css = readFileSync(join(process.cwd(), "shared", "chrome.css"), "utf8");
    expect(css).toMatch(/\.titlebar-context\s*{[^}]*margin-left:\s*auto;/s);
  });
});

describe("TitleBar project icons", () => {
  const FOUND = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
  const PICKED = "data:image/png;base64,iVBORw0KGgo=";

  const renderTabs = (
    open: Project[],
    opts: { icons?: Record<string, string>; asleep?: string[] } = {},
  ) => {
    const onCloseProject = vi.fn();
    const onSelectProject = vi.fn();
    render(
      <TitleBar
        projects={open}
        openProjects={open}
        activeId={open[0].id}
        pendingCount={() => 0}
        collabActive={false}
        tabDragId={null}
        tabDragOffsetX={0}
        tabDragItemProps={(id) => ({ "data-drag-id": id, onPointerDown: () => {} })}
        hibernated={Object.fromEntries((opts.asleep ?? []).map((id) => [id, {}]))}
        showHints={false}
        notifCount={0}
        notifUrgency="low"
        onOpenNotifications={() => {}}
        onOpenProject={() => {}}
        onSelectProject={onSelectProject}
        onCloseProject={onCloseProject}
        onHibernateProject={() => {}}
        onTogglePinProject={() => {}}
        onWakeProject={() => {}}
        onToggleVibe={() => {}}
        onEditProject={() => {}}
        onStopCollab={() => {}}
        onNewProject={() => {}}
        onManageProjects={() => {}}
        projectIcons={opts.icons}
      />,
    );
    return { onCloseProject, onSelectProject };
  };
  const tab = (name: string) => screen.getByText(name).closest(".project-tab") as HTMLElement;

  it("shows the detected icon before the name, as an <img>", () => {
    renderTabs([project("a", "Acme Widgets")], { icons: { a: FOUND } });
    const img = tab("Acme Widgets").querySelector("img.project-tab-icon") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe(FOUND);
    expect(img.nextElementSibling?.textContent).toBe("Acme Widgets");
    // Never inlined: no <svg> from the project lands in the page.
    const svgs = [...tab("Acme Widgets").querySelectorAll("svg")];
    expect(svgs.every((svg) => svg.closest(".tab-close"))).toBe(true);
  });

  it("keeps today's text-only tab when nothing was found", () => {
    renderTabs([project("a", "Acme Widgets")], { icons: {} });
    expect(tab("Acme Widgets").querySelector(".project-tab-icon")).toBeNull();
  });

  it("falls back to text when the icon fails to load", () => {
    renderTabs([project("a", "Acme Widgets")], { icons: { a: FOUND } });
    const img = tab("Acme Widgets").querySelector("img.project-tab-icon")!;
    fireEvent.error(img);
    expect(tab("Acme Widgets").querySelector(".project-tab-icon")).toBeNull();
    expect(screen.getByText("Acme Widgets")).toBeTruthy();
  });

  it("lets the user's choice win over the detected icon", () => {
    renderTabs(
      [
        { ...project("a", "Glyph Co"), icon: { kind: "emoji", emoji: "🚀" } },
        { ...project("b", "Plain Co"), icon: { kind: "none" } },
        { ...project("c", "Picked Co"), icon: { kind: "image", dataUrl: PICKED } },
      ],
      { icons: { a: FOUND, b: FOUND, c: FOUND } },
    );
    expect(tab("Glyph Co").querySelector(".project-tab-glyph")?.textContent).toBe("🚀");
    expect(tab("Glyph Co").querySelector("img")).toBeNull();
    expect(tab("Plain Co").querySelector(".project-tab-icon")).toBeNull();
    expect(tab("Picked Co").querySelector("img.project-tab-icon")?.getAttribute("src")).toBe(PICKED);
  });

  it("keeps the hibernation frost and the close button working", () => {
    const { onCloseProject, onSelectProject } = renderTabs(
      [project("a", "Awake Co"), project("z", "Sleepy Co")],
      { icons: { a: FOUND, z: FOUND }, asleep: ["z"] },
    );
    const sleepy = tab("Sleepy Co");
    expect(sleepy.classList.contains("project-tab-asleep")).toBe(true);
    expect(sleepy.querySelector(".project-tab-frost")).not.toBeNull();
    expect(sleepy.querySelector("img.project-tab-icon")).not.toBeNull();
    fireEvent.click(sleepy.querySelector(".tab-close")!);
    expect(onCloseProject).toHaveBeenCalledWith("z");
    expect(onSelectProject).not.toHaveBeenCalled();
  });

  it("sizes the icon to a fixed small box and keeps the name the only classless span", () => {
    const css = readFileSync(join(process.cwd(), "src/index.css"), "utf8");
    expect(css).toMatch(/\.project-tab-icon\s*{[^}]*flex:\s*0 0 auto;[^}]*width:\s*14px;[^}]*height:\s*14px;/s);
    renderTabs([project("a", "Acme Widgets")], { icons: { a: FOUND } });
    expect(tab("Acme Widgets").querySelectorAll(":scope > span:not([class])")).toHaveLength(1);
  });
});
