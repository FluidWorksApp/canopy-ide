// @vitest-environment jsdom
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StructuredRunnerEvent } from "../structuredEvents";
import {
  VibeBuilderPane,
  vibeStarterIdeas,
} from "./VibeBuilderPane";
import type { ComponentRole, Project } from "../projects";
import type {
  BuilderSession,
  BuilderSessionState,
} from "../vibeBuilderSessionTypes";

vi.mock("./Markdown", () => ({
  Markdown: ({ text }: { text: string }) => <p>{text}</p>,
}));

vi.mock("../mascots", () => ({
  mascotDef: () => ({ label: "Ash" }),
}));

vi.mock("./Mascot", () => ({
  Mascot: ({ state, tone, size, title }: {
    state: string;
    tone: string;
    size: number;
    title: string;
  }) => (
    <div
      role="img"
      aria-label={title}
      data-state={state}
      data-tone={tone}
      data-size={size}
    />
  ),
}));

afterEach(cleanup);

function harness(initial: BuilderSessionState) {
  let state = initial;
  const listeners = new Set<(event: StructuredRunnerEvent) => void>();
  const send = vi.fn<(text: string) => void | Promise<void>>();
  const cancelCurrentTurn = vi.fn<() => void | Promise<void>>();
  const session: BuilderSession = {
    events$: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    send,
    cancelCurrentTurn,
    get state() {
      return state;
    },
  };
  return {
    session,
    send,
    cancelCurrentTurn,
    setState(next: BuilderSessionState) {
      state = next;
    },
    emit(event: StructuredRunnerEvent) {
      for (const listener of [...listeners]) listener(event);
    },
    listeners,
  };
}

const idle = (): BuilderSessionState => ({ persona: { kind: "idle" } });
const openTranscript = () =>
  fireEvent.click(screen.getByRole("button", { name: /Transcript/ }));

const discoveredProject = (
  id: string,
  role: ComponentRole,
  purposes: Array<"serve" | "check" | "worker" | "setup"> = ["serve"],
): Project => ({
  id,
  name: "Product",
  components: [{
    id: "main",
    label: "Main",
    path: "/project",
    role,
    commands: purposes.map((purpose, index) => ({
      id: `command-${index}`,
      name: purpose,
      command: purpose,
      purpose,
    })),
  }],
  vibe: {
    version: 1,
    enabled: true,
    setupRevision: "tree-1",
    componentId: "main",
    runCommandId: "command-0",
    requiredProcesses: [{ componentId: "main", runCommandId: "command-0" }],
    externalServices: [],
  },
});

describe("VibeBuilderPane", () => {
  it("renders consecutive tool events as one latest-tool row with a count", () => {
    const h = harness(idle());
    render(<VibeBuilderPane session={h.session} />);
    openTranscript();

    act(() => {
      h.setState({ persona: { kind: "turn-progress" } });
      h.emit({ kind: "delta", text: "I added " });
      h.emit({ kind: "delta", text: "the checkout page." });
      h.emit({ kind: "tool", name: "Read", detail: "src/Checkout.tsx" });
      h.emit({ kind: "tool", name: "canopy_browser_snapshot", detail: "/checkout" });
    });

    expect(screen.getByText("I added the checkout page.")).toBeTruthy();
    const cards = document.querySelectorAll(".vibe-builder-activity");
    expect(cards).toHaveLength(1);
    expect(document.querySelectorAll(".companion-tool")).toHaveLength(0);
    const row = screen.getByRole("button", { name: /canopy_browser_snapshot/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(within(row).getByText("+1")).toBeTruthy();
    expect(screen.queryByText("src/Checkout.tsx")).toBeNull();

    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("src/Checkout.tsx")).toBeTruthy();
    expect(document.querySelectorAll(".companion-tool")).toHaveLength(2);
  });

  it("starts a new activity row after assistant prose resumes", () => {
    const h = harness(idle());
    render(<VibeBuilderPane session={h.session} />);
    openTranscript();
    act(() => {
      h.emit({ kind: "tool", name: "Glob" });
      h.emit({ kind: "tool", name: "Grep" });
      h.emit({ kind: "delta", text: "I found it." });
      h.emit({ kind: "tool", name: "Edit" });
    });
    expect(document.querySelectorAll(".vibe-builder-activity")).toHaveLength(2);
  });

  it("sends from the plain input row and shows the local user turn", () => {
    const h = harness(idle());
    render(<VibeBuilderPane session={h.session} />);
    const input = screen.getByRole("textbox", { name: "Message Ash" });

    fireEvent.change(input, { target: { value: "Make the button blue" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(h.send).toHaveBeenCalledWith("Make the button blue");
    const receipt = screen.getByLabelText("Your latest request");
    expect(within(receipt).getByText("You asked")).toBeTruthy();
    expect(within(receipt).getByText("Make the button blue")).toBeTruthy();
    openTranscript();
    expect(screen.queryByLabelText("Your latest request")).toBeNull();
    expect(screen.getByText("Make the button blue")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Ash is thinking" })).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps the product unobstructed until Transcript morphs the pill into a cushion", () => {
    const h = harness(idle());
    render(<VibeBuilderPane session={h.session} />);
    const pane = screen.getByRole("region", { name: "Ash builder" });
    const transcript = screen.getByRole("button", { name: /Transcript/ });

    expect(pane.classList.contains("is-pill")).toBe(true);
    expect(transcript.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(transcript);
    expect(pane.classList.contains("is-cushion")).toBe(true);
    expect(transcript.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(transcript);
    expect(pane.classList.contains("is-pill")).toBe(true);
  });

  it("collapses while working, then expands only for an engaged composer", () => {
    const h = harness({ persona: { kind: "turn-progress" } });
    render(<VibeBuilderPane session={h.session} />);
    const pane = screen.getByRole("region", { name: "Ash builder" });
    const input = screen.getByRole("textbox", { name: "Message Ash" });
    const transcript = screen.getByRole("button", { name: "Open Transcript" });

    expect(pane.classList.contains("is-collapsed")).toBe(true);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(transcript.textContent).toBe("");

    fireEvent.focus(input);
    expect(pane.classList.contains("is-composer-open")).toBe(true);
    expect(input.getAttribute("aria-expanded")).toBe("true");

    fireEvent.change(input, { target: { value: "Keep the title short" } });
    fireEvent.blur(input);
    expect(pane.classList.contains("is-composer-open")).toBe(true);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.send).toHaveBeenCalledWith("Keep the title short");
    expect(pane.classList.contains("is-collapsed")).toBe(true);
    expect(screen.getByLabelText("Your latest request").textContent).toContain(
      "Keep the title short",
    );
  });

  it("shows later messages as an ordered queue until the session accepts them", async () => {
    const h = harness(idle());
    let acceptSecond!: () => void;
    h.send
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => { acceptSecond = resolve; }),
      );
    render(<VibeBuilderPane session={h.session} />);
    const input = screen.getByRole("textbox", { name: "Message Ash" });

    fireEvent.change(input, { target: { value: "Connect Supabase" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "Then deploy it" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const queue = screen.getByLabelText("1 queued request");
    expect(within(queue).getByText("Then deploy it")).toBeTruthy();
    expect(screen.getByLabelText("Your latest request").textContent).toContain(
      "Connect Supabase",
    );

    acceptSecond();
    await waitFor(() => expect(screen.queryByLabelText("1 queued request")).toBeNull());
    expect(screen.getByLabelText("Your latest request").textContent).toContain(
      "Then deploy it",
    );
  });

  it("minimizes a pending question independently from the composer", () => {
    const h = harness({
      persona: { kind: "question-asked" },
      question: {
        id: "repair-later",
        kind: "question",
        prompt: "The app server keeps stopping.",
        detail: "I found the cause and can fix it when you're ready.",
      },
    });
    render(<VibeBuilderPane session={h.session} />);
    const pane = screen.getByRole("region", { name: "Ash builder" });
    const input = screen.getByRole("textbox", { name: "Message Ash" });

    expect(screen.getByText("The app server keeps stopping.")).toBeTruthy();
    expect(screen.queryByText("What should we make?")).toBeNull();
    const collapse = screen.getByRole("button", { name: "Collapse question" });
    expect(collapse.closest(".vibe-builder-cushion-body")).not.toBeNull();
    expect(
      collapse.parentElement?.classList.contains("vibe-builder-cushion-controls"),
    ).toBe(true);

    input.focus();
    expect(document.activeElement).toBe(input);
    fireEvent.mouseDown(collapse);
    fireEvent.click(collapse);

    expect(document.activeElement).toBe(input);
    expect(pane.classList.contains("is-composer-open")).toBe(true);
    expect(screen.queryByText("The app server keeps stopping.")).toBeNull();
    expect(h.send).not.toHaveBeenCalled();

    const restore = screen.getByRole("button", { name: "Show pending question" });
    expect(restore.closest("form")).not.toBeNull();
    fireEvent.click(restore);
    expect(pane.classList.contains("is-cushion")).toBe(true);
    expect(screen.getByText("The app server keeps stopping.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Collapse question" }));
    expect(pane.classList.contains("is-collapsed")).toBe(true);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("shows the real discovery state and stops only the current turn", async () => {
    const h = harness({ persona: { kind: "turn-progress" } });
    render(
      <VibeBuilderPane
        session={h.session}
        phase="discovering"
      />,
    );

    const pane = screen.getByRole("region", { name: "Ash builder" });
    expect(pane.getAttribute("data-signal")).toBe("discovering");
    expect(pane.getAttribute("data-blocking")).toBe("true");
    expect(screen.getByText("Understanding your project…")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Message Ash" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop current change" }));
    await waitFor(() => expect(h.cancelCurrentTurn).toHaveBeenCalledTimes(1));
    expect(h.send).not.toHaveBeenCalled();
  });

  it("offers editable starting ideas that match the discovered project", async () => {
    const h = harness(idle());
    const project = discoveredProject("api-starters", "api", ["serve", "check"]);
    render(<VibeBuilderPane session={h.session} project={project} />);

    fireEvent.click(screen.getByRole("button", {
      name: /Make the service easier to rely on/,
    }));

    const input = screen.getByRole("textbox", { name: "Message Ash" });
    expect((input as HTMLTextAreaElement).value).toBe(
      "Make the service easier to rely on",
    );
    expect(screen.queryByText(/landing page/i)).toBeNull();
    expect(screen.getByText("Check that everything is working")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(h.send).not.toHaveBeenCalled();
  });

  it("offers no invented starters before project discovery completes", () => {
    const project = discoveredProject("unknown-starters", "api");
    project.vibe = { version: 1, enabled: true };
    expect(vibeStarterIdeas(project)).toEqual([]);

    const h = harness(idle());
    render(<VibeBuilderPane session={h.session} project={project} />);
    expect(screen.queryByLabelText("Starting ideas")).toBeNull();
    openTranscript();
    expect(screen.getByText(/learn the project before suggesting/i)).toBeTruthy();
  });

  it("does not ask for a reply to something Canopy is already handling", () => {
    // Shipped state: the crash-loop incident said "The app server keeps
    // stopping. I'm reading its output to find out why." and then, underneath,
    // "Reply below." — telling the person to act on the one thing a repair
    // agent had just taken over.
    const h = harness(idle());
    render(<VibeBuilderPane session={h.session} />);
    act(() => {
      h.setState({
        persona: { kind: "incident" },
        question: {
          id: "n1",
          kind: "notice",
          prompt: "The app server keeps stopping.",
          detail: "I'm reading its output to find out why.",
        },
      });
      h.emit({ kind: "ready" });
    });
    const notice = screen.getByRole("group", {
      name: "Update: The app server keeps stopping.",
    });
    expect(within(notice).getByText("I'm reading its output to find out why.")).toBeTruthy();
    expect(within(notice).queryByText("Reply below.")).toBeNull();
    expect(screen.getByRole("img", { name: "Ash is thinking" })).toBeTruthy();
    expect(screen.queryByText("Waiting for you")).toBeNull();
  });

  it("pins the persona to needs while a question is outstanding", () => {
    const h = harness(idle());
    render(<VibeBuilderPane session={h.session} />);
    expect(screen.getByRole("img", { name: "Ash is idle" })).toBeTruthy();

    act(() => {
      h.setState({
        persona: { kind: "verify-running" },
        question: {
          id: "q1",
          kind: "question",
          prompt: "Which page should open first?",
        },
      });
      h.emit({ kind: "ready" });
    });

    expect(screen.getByRole("img", { name: "Ash is needs" })).toBeTruthy();
    const question = screen.getByRole("group", {
      name: "Question: Which page should open first?",
    });
    expect(within(question).getByText("Reply below.")).toBeTruthy();
    expect(document.activeElement).toBe(question);

    act(() => {
      h.setState({ persona: { kind: "question-answered" }, question: null });
      h.emit({ kind: "ready" });
    });
    expect(screen.getByRole("img", { name: "Ash is thinking" })).toBeTruthy();
  });

  it("renders confirm actions through the same narrow send boundary", () => {
    const h = harness({
      persona: { kind: "question-asked" },
      question: {
        id: "confirm-1",
        kind: "confirm",
        prompt: "Apply the database migration?",
        detail: "Adds an orders table; existing data is unchanged.",
        diff: "+ create table orders",
        actions: [
          { label: "Apply it", response: "approve" },
          { label: "Not now", response: "decline" },
        ],
      },
    });
    render(<VibeBuilderPane session={h.session} />);

    const confirm = screen.getByRole("group", {
      name: "Confirm: Apply the database migration?",
    });
    expect(within(confirm).getByText(/Adds an orders table/)).toBeTruthy();
    expect(within(confirm).getByText("+ create table orders")).toBeTruthy();
    const apply = within(confirm).getByRole("button", { name: "Apply it" });
    fireEvent.click(apply);
    expect(h.send).toHaveBeenCalledWith("approve");
    expect(apply.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("img", { name: "Ash is needs" })).toBeTruthy();
  });

  it("reacts to replaced state snapshots without erasing streamed prose", () => {
    const h = harness(idle());
    const mounted = render(<VibeBuilderPane session={h.session} />);
    openTranscript();
    act(() => h.emit({ kind: "reply", text: "The preview is ready." }));

    h.setState({ persona: { kind: "verify-passed" } });
    mounted.rerender(<VibeBuilderPane session={h.session} />);

    expect(screen.getByText("The preview is ready.")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Ash is done" })).toBeTruthy();
  });

  it("keeps question presence authoritative without masking blocked", () => {
    const h = harness({
      persona: { kind: "permission-stall" },
      question: {
        id: "permission",
        kind: "confirm",
        prompt: "Allow this action?",
      },
    });
    const mounted = render(<VibeBuilderPane session={h.session} />);
    expect(screen.getByRole("img", { name: "Ash is blocked" })).toBeTruthy();

    h.setState({
      persona: { kind: "question-answered" },
      question: {
        id: "permission",
        kind: "confirm",
        prompt: "Allow this action?",
      },
    });
    mounted.rerender(<VibeBuilderPane session={h.session} />);
    expect(screen.getByRole("img", { name: "Ash is needs" })).toBeTruthy();

    h.setState({ persona: { kind: "verify-passed" }, question: null });
    mounted.rerender(<VibeBuilderPane session={h.session} />);
    expect(screen.getByRole("img", { name: "Ash is done" })).toBeTruthy();
  });

  it("contains an async send failure instead of leaving an unhandled rejection", async () => {
    const h = harness(idle());
    h.send.mockRejectedValueOnce(new Error("session stopped"));
    render(<VibeBuilderPane session={h.session} />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Try this change" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    openTranscript();

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("session stopped");
    });
  });

  it("re-enables a confirm card when the runner reports an error", () => {
    const h = harness({
      persona: { kind: "question-asked" },
      question: {
        id: "retry-confirm",
        kind: "confirm",
        prompt: "Try the migration?",
        actions: [{ label: "Try it", response: "approve" }],
      },
    });
    render(<VibeBuilderPane session={h.session} />);
    openTranscript();
    const action = screen.getByRole("button", { name: "Try it" });
    fireEvent.click(action);
    expect(action.hasAttribute("disabled")).toBe(true);

    act(() => h.emit({ kind: "error", message: "The runner stopped." }));
    expect(action.hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain("runner stopped");
  });

  it("keeps a person's turn through internal session swaps and a project remount", async () => {
    let reject!: (error: Error) => void;
    const project = discoveredProject("session-handoff", "api");
    const first = harness(idle());
    first.send.mockReturnValueOnce(
      new Promise<void>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
    );
    const mounted = render(<VibeBuilderPane session={first.session} project={project} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Old session message" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const second = harness(idle());
    // Setup, waiting and the live builder are internal session identities, not
    // new conversations. The old expectation erased the person's visible turn
    // here, which also made the first-visit card come back.
    mounted.rerender(<VibeBuilderPane session={second.session} project={project} />);
    await act(async () => {
      reject(new Error("old session stopped"));
      await Promise.resolve();
    });

    expect(screen.queryByRole("alert")).toBeNull();
    openTranscript();
    expect(screen.getByText("Old session message")).toBeTruthy();
    expect(screen.queryByText("What should we make?")).toBeNull();

    const otherProject = discoveredProject("other-project", "web");
    const other = harness(idle());
    mounted.rerender(
      <VibeBuilderPane session={other.session} project={otherProject} />,
    );
    expect(screen.queryByText("Old session message")).toBeNull();
    expect(screen.getByText("What should we make?")).toBeTruthy();

    const returned = harness(idle());
    mounted.rerender(<VibeBuilderPane session={returned.session} project={project} />);
    openTranscript();
    expect(screen.getByText("Old session message")).toBeTruthy();
    expect(screen.queryByText("What should we make?")).toBeNull();

    mounted.unmount();
    const third = harness(idle());
    render(<VibeBuilderPane session={third.session} project={project} />);
    openTranscript();
    expect(screen.getByText("Old session message")).toBeTruthy();
    expect(screen.queryByText("What should we make?")).toBeNull();
  });

  it("announces completed prose once the turn ends, not on every delta", () => {
    const h = harness(idle());
    render(<VibeBuilderPane session={h.session} />);
    const status = document.querySelector(".vibe-builder-announcement")!;

    act(() => h.emit({ kind: "delta", text: "The page is ready." }));
    expect(status.textContent).toBe("");
    act(() => h.emit({ kind: "turnEnd" }));
    expect(status.textContent).toContain("Ash replied: The page is ready.");
  });

  it("unsubscribes from the event stream when the pane leaves", () => {
    const h = harness(idle());
    const mounted = render(<VibeBuilderPane session={h.session} />);
    expect(h.listeners.size).toBe(1);
    mounted.unmount();
    expect(h.listeners.size).toBe(0);
  });
});

describe("the builder pane boundary", () => {
  const source = readFileSync(
    join(process.cwd(), "src/components/VibeBuilderPane.tsx"),
    "utf8",
  );

  it("takes events, send and state without owning runner or envelope machinery", () => {
    expect(source).toContain("vibeBuilderSessionTypes");
    for (const forbidden of [
      "projectRunner",
      "structuredRunners",
      "TaskEnvelope",
      "taskEnvelope",
      "taskTranscript",
      "companionSession",
      "ProjectView",
      "localStorage",
      "startStructured",
      "spawn(",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).not.toMatch(/from ["']\.\.\/ipc["']/);
  });

  it("gets every mascot face through personaBridge and reducePersona", () => {
    expect(source).toContain('from "../personaBridge"');
    expect(source).toContain("reducePersona(");
    expect(source).toContain("state={view.persona.state}");
    expect(source).not.toMatch(/<Mascot[^>]*state=["']/s);
  });

  it("takes its atmosphere from skin tokens and respects material and motion variants", () => {
    const css = readFileSync(join(process.cwd(), "src/index.css"), "utf8");
    const build = css.slice(
      css.indexOf("/* ── Build mode"),
      css.indexOf("/* ── The agents page"),
    );
    expect(build).toContain("var(--accent)");
    expect(build).toContain("var(--cyan)");
    expect(build).toContain(':root[data-theme="pixel"]');
    expect(build).toContain(':root[data-theme="vitrine"]');
    expect(build).toContain("backdrop-filter: blur(");
    expect(build).toContain("saturate(");
    expect(build).toContain("prefers-reduced-motion: reduce");
    expect(build).not.toMatch(/#[0-9a-f]{3,8}/i);
  });
});
