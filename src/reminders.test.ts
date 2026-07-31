import { describe as suite, expect, it } from "vitest";
import {
  PRESETS,
  announcement,
  describe,
  describeFull,
  earliest,
  fromLocalInput,
  presetsFor,
  reminderRank,
  shouldAnnounce,
  toLocalInput,
} from "./reminders";
import type { NoteDue } from "./ipc";

/** A fixed local moment: Wednesday 2026-07-29, 14:30 wherever the test runs.
 *  Built from local fields on purpose — every assertion below is about the
 *  user's own clock, so a UTC constant would make the suite pass or fail by
 *  timezone. */
const NOW = Math.floor(new Date(2026, 6, 29, 14, 30, 0, 0).getTime() / 1000);
const at = (...args: [number, number, number, number, number]) =>
  Math.floor(new Date(...args, 0, 0).getTime() / 1000);

suite("presets", () => {
  it("lands each one on the wall clock it names", () => {
    const by = (id: string) => PRESETS.find((p) => p.id === id)!.at(NOW);
    expect(by("hour")).toBe(NOW + 3600);
    expect(by("evening")).toBe(at(2026, 6, 29, 18, 0));
    expect(by("tomorrow")).toBe(at(2026, 6, 30, 9, 0));
    // Wednesday → the following Monday.
    expect(by("week")).toBe(at(2026, 7, 3, 9, 0));
  });

  it("never offers a preset that is already behind you", () => {
    // 20:00: "this evening" has been and gone, and offering it would set a
    // reminder for tomorrow evening without saying so.
    const evening = at(2026, 6, 29, 20, 0);
    const ids = presetsFor(evening).map((p) => p.id);
    expect(ids).not.toContain("evening");
    expect(ids).toContain("tomorrow");
  });

  it("reads next Monday as the one after this one, asked on a Monday", () => {
    const monday = at(2026, 7, 3, 10, 0);
    expect(PRESETS.find((p) => p.id === "week")!.at(monday)).toBe(
      at(2026, 7, 10, 9, 0),
    );
  });
});

suite("the picker's two conversions", () => {
  it("round-trips a local time without drifting by the UTC offset", () => {
    const value = toLocalInput(NOW);
    expect(value).toBe("2026-07-29T14:30");
    expect(fromLocalInput(value)).toBe(NOW);
  });

  it("refuses anything that is not a datetime-local value", () => {
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("tomorrow")).toBeNull();
    expect(fromLocalInput("2026-07-29")).toBeNull();
  });

  it("floors the picker a minute out, never in the past", () => {
    expect(fromLocalInput(earliest(NOW))!).toBeGreaterThan(NOW);
  });
});

suite("describe", () => {
  it("says the clock time for today and tomorrow", () => {
    expect(describe(at(2026, 6, 29, 18, 0), NOW)).toBe("today 18:00");
    expect(describe(at(2026, 6, 30, 9, 0), NOW)).toBe("tomorrow 09:00");
  });

  it("falls back to a weekday inside the week and a date beyond it", () => {
    expect(describe(at(2026, 6, 31, 9, 0), NOW)).toMatch(/^\w{3}.* 09:00$/);
    expect(describe(at(2026, 8, 14, 9, 0), NOW)).toMatch(/09:00$/);
  });

  it("states overdue as elapsed time, because the alarm already happened", () => {
    expect(describe(NOW - 30, NOW)).toBe("due now");
    expect(describe(NOW - 3 * 3600, NOW)).toBe("3 hours overdue");
    expect(describe(NOW - 26 * 3600, NOW)).toBe("1 day overdue");
    expect(describeFull(NOW - 3600, NOW)).toContain("ago");
    expect(describeFull(NOW + 3600, NOW)).toContain("in 1 hour");
  });
});

suite("ordering", () => {
  it("puts overdue above upcoming above notes with no reminder", () => {
    const r = (secs: number) => ({
      at: secs,
      note: "",
      by: "",
      created_at: 0,
      system: true,
    });
    expect(reminderRank(r(NOW - 60), NOW)).toBeLessThan(
      reminderRank(r(NOW + 60), NOW),
    );
    expect(reminderRank(r(NOW + 60), NOW)).toBeLessThan(
      reminderRank(null, NOW),
    );
  });
});

suite("announcing", () => {
  const due = (over: Partial<NoteDue> = {}): NoteDue => ({
    project_id: "p1",
    id: "0007-tier-donations",
    title: "Tier donations need a cap",
    note: "",
    at: NOW,
    by: "you",
    system: true,
    link: "canopy://note?note=0007-tier-donations&id=p1",
    ...over,
  });

  it("stays quiet when the system already put a banner up", () => {
    // The double-notification guard. If this ever inverts, every reminder set
    // while Canopy was open arrives twice.
    expect(shouldAnnounce(due({ system: true }))).toBe(false);
    expect(shouldAnnounce(due({ system: false }))).toBe(true);
  });

  it("leads with what the user wrote, and says something when they wrote nothing", () => {
    expect(announcement(due({ note: "before the pricing call" })).body).toBe(
      "before the pricing call",
    );
    expect(announcement(due()).body).toContain("asked to be reminded");
    expect(announcement(due()).title).toContain("Tier donations");
  });
});
