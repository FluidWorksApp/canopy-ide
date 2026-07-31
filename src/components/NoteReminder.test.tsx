import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NoteReminder } from "./NoteReminder";
import type { NoteReminder as Reminder } from "../ipc";
import { nowSecs } from "../reminders";

const reminder = (over: Partial<Reminder> = {}): Reminder => ({
  at: nowSecs() + 3600,
  note: "",
  by: "you",
  created_at: nowSecs(),
  system: true,
  ...over,
});

describe("NoteReminder", () => {
  it("offers presets and reports the instant one names", () => {
    const onSet = vi.fn();
    render(<NoteReminder onSet={onSet} />);
    fireEvent.click(screen.getByRole("button", { name: /remind me/i }));
    fireEvent.click(screen.getByText("In an hour"));
    expect(onSet).toHaveBeenCalledTimes(1);
    const [at] = onSet.mock.calls[0];
    expect(at).toBeGreaterThan(nowSecs());
    expect(at).toBeLessThanOrEqual(nowSecs() + 3601);
  });

  it("closes the menu after setting, so the note is what you see next", () => {
    render(<NoteReminder onSet={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /remind me/i }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.click(screen.getByText("Tomorrow morning"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("clears with null — the one value the store reads as 'take it off'", () => {
    const onSet = vi.fn();
    const { container } = render(
      <NoteReminder reminder={reminder()} onSet={onSet} />,
    );
    fireEvent.click(container.querySelector(".note-remind-chip")!);
    fireEvent.click(screen.getByText("Remove reminder"));
    expect(onSet).toHaveBeenCalledWith(null, undefined);
  });

  it("offers no way to remove a reminder that isn't there", () => {
    render(<NoteReminder onSet={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /remind me/i }));
    expect(screen.queryByText("Remove reminder")).toBeNull();
  });

  it("marks an overdue chip so the row can colour it", () => {
    const { container } = render(
      <NoteReminder reminder={reminder({ at: nowSecs() - 7200 })} onSet={vi.fn()} />,
    );
    const chip = container.querySelector(".note-remind-chip");
    expect(chip?.className).toContain("overdue");
    expect(chip?.textContent).toContain("overdue");
  });

  it("says which alarm will hold it, rather than promising one it can't keep", () => {
    const { rerender } = render(<NoteReminder onSet={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /remind me/i }));
    expect(screen.getByText(/even with Canopy closed/)).toBeTruthy();

    rerender(<NoteReminder onSet={vi.fn()} systemCapable={false} />);
    expect(screen.getByText(/has to be running/)).toBeTruthy();
  });

  it("carries the user's line through to the store", () => {
    const onSet = vi.fn();
    render(<NoteReminder onSet={onSet} />);
    fireEvent.click(screen.getByRole("button", { name: /remind me/i }));
    fireEvent.change(screen.getByPlaceholderText(/what to say/i), {
      target: { value: "  before the pricing call  " },
    });
    fireEvent.click(screen.getByText("In an hour"));
    expect(onSet.mock.calls[0][1]).toBe("before the pricing call");
  });

  it("refuses a picked time that has already gone", () => {
    const onSet = vi.fn();
    render(<NoteReminder onSet={onSet} />);
    fireEvent.click(screen.getByRole("button", { name: /remind me/i }));
    const input = document.querySelector(
      "input[type=datetime-local]",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2020-01-01T09:00" } });
    fireEvent.click(screen.getByText("Set"));
    expect(onSet).not.toHaveBeenCalled();
  });
});
