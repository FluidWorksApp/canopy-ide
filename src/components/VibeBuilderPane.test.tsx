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
} from "./VibeBuilderPane";
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
  const session: BuilderSession = {
    events$: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    send,
    get state() {
      return state;
    },
  };
  return {
    session,
    send,
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

describe("VibeBuilderPane", () => {
  it("renders consecutive tool events as one latest-tool row with a count", () => {
    const h = harness(idle());
    render(<VibeBuilderPane session={h.session} />);

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
    expect(screen.getByText("Make the button blue")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Ash is thinking" })).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("turns a non-technical starting idea into an editable message", async () => {
    const h = harness(idle());
    render(<VibeBuilderPane session={h.session} />);

    fireEvent.click(screen.getByRole("button", {
      name: /Make this experience feel premium/,
    }));

    const input = screen.getByRole("textbox", { name: "Message Ash" });
    expect((input as HTMLTextAreaElement).value).toBe(
      "Make this experience feel premium",
    );
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(h.send).not.toHaveBeenCalled();
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
    const action = screen.getByRole("button", { name: "Try it" });
    fireEvent.click(action);
    expect(action.hasAttribute("disabled")).toBe(true);

    act(() => h.emit({ kind: "error", message: "The runner stopped." }));
    expect(action.hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain("runner stopped");
  });

  it("ignores a late send failure after the session changes", async () => {
    let reject!: (error: Error) => void;
    const first = harness(idle());
    first.send.mockReturnValueOnce(
      new Promise<void>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
    );
    const mounted = render(<VibeBuilderPane session={first.session} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Old session message" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const second = harness(idle());
    mounted.rerender(<VibeBuilderPane session={second.session} />);
    await act(async () => {
      reject(new Error("old session stopped"));
      await Promise.resolve();
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Old session message")).toBeNull();
  });

  it("announces completed prose once the turn ends, not on every delta", () => {
    const h = harness(idle());
    render(<VibeBuilderPane session={h.session} />);
    const status = screen.getByRole("status");

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
    expect(build).toContain("prefers-reduced-motion: reduce");
    expect(build).not.toMatch(/#[0-9a-f]{3,8}/i);
  });
});
