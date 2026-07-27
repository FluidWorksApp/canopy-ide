import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { AgentRuntime } from "./AgentRuntime";

/** Fix "now" so the chip's arithmetic is a function of its props alone. */
const NOW_MS = 1_800_000_000_000;
const NOW_SECS = NOW_MS / 1000;

function freezeClock() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the agent runtime chip", () => {
  it("says nothing at all about a session that has never worked", () => {
    freezeClock();
    const { container } = render(
      <AgentRuntime timing={{ updated: NOW_SECS }} live={true} />,
    );
    // A 0:00 on a brand-new agent reads as a broken clock, not an honest zero.
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the session's total once it has stopped working", () => {
    freezeClock();
    render(
      <AgentRuntime
        timing={{ active_secs: 3_862, run_secs: 300, updated: NOW_SECS - 60 }}
        live={false}
      />,
    );
    expect(screen.getByText("1:04:22")).toBeInTheDocument();
    expect(screen.queryByText("5:00")).not.toBeInTheDocument();
  });

  // The panel row is 300px wide and truncates rather than wraps, so it gets the
  // number that matters where it is and keeps the other in its tooltip.
  it("gives a panel row the live stretch alone", () => {
    freezeClock();
    render(
      <AgentRuntime
        timing={{ active_secs: 3_862, run_secs: 300, updated: NOW_SECS }}
        live={true}
      />,
    );
    expect(screen.getByText("5:00")).toBeInTheDocument();
    expect(screen.queryByText("1:04:22")).not.toBeInTheDocument();
  });

  it("shows the current stretch beside the lifetime total where there is room", () => {
    freezeClock();
    render(
      <AgentRuntime
        timing={{ active_secs: 3_862, run_secs: 300, updated: NOW_SECS }}
        live={true}
        variant="stat"
      />,
    );
    expect(screen.getByText("5:00")).toBeInTheDocument();
    expect(screen.getByText("1:04:22")).toBeInTheDocument();
  });

  // A first stretch has run === total; printing it twice says nothing twice.
  it("does not repeat itself when the run is the whole session", () => {
    freezeClock();
    render(
      <AgentRuntime
        timing={{ active_secs: 300, run_secs: 300, updated: NOW_SECS }}
        live={true}
        variant="stat"
      />,
    );
    expect(screen.getAllByText("5:00")).toHaveLength(1);
  });

  it("counts up on its own while the agent is working", () => {
    freezeClock();
    render(
      <AgentRuntime
        timing={{ active_secs: 100, run_secs: 100, updated: NOW_SECS }}
        live={true}
      />,
    );
    expect(screen.getByText("1:40")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByText("1:43")).toBeInTheDocument();
  });

  // The failure this guards: a CLI that dies mid-turn leaves "working" in its
  // digest forever. A timer that kept counting from that would show a dead
  // agent racking up hours of work it never did.
  it("freezes rather than counting for an agent we have lost track of", () => {
    freezeClock();
    render(
      <AgentRuntime
        timing={{ active_secs: 100, run_secs: 100, updated: NOW_SECS - 86_400 }}
        live={false}
      />,
    );
    expect(screen.getByText("1:40")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText("1:40")).toBeInTheDocument();
  });

  it("spells both numbers out, and what they exclude, on hover", () => {
    freezeClock();
    const { container } = render(
      <AgentRuntime
        timing={{ active_secs: 3_862, run_secs: 300, updated: NOW_SECS }}
        live={true}
      />,
    );
    const title = container.querySelector(".agent-runtime")?.getAttribute("title") ?? "";
    expect(title).toContain("Working for 5 minutes without a break");
    expect(title).toContain("1 hour 4 minutes of work in this session");
    expect(title).toContain("idle or waiting on you is not counted");
  });
});
