import { beforeEach, describe, expect, it } from "vitest";
import {
  clearHistory,
  HistoryCycle,
  loadHistory,
  MAX_STORED,
  pushTranscript,
  stillHolding,
  timeAgo,
  type TranscriptEntry,
} from "./dictationHistory";
import { matchesHotkey, type Hotkey } from "./settings";

/** ⌃⌘V — the default on Mac, and the one whose two modifiers make the
 *  hold-to-cycle interesting. */
const HOTKEY: Hotkey = {
  meta: true,
  ctrl: true,
  alt: false,
  shift: false,
  code: "KeyV",
};

function key(
  code: string,
  mods: Partial<
    Record<"meta" | "ctrl" | "alt" | "shift" | "repeat", boolean>
  > = {},
) {
  return {
    code,
    key: code.startsWith("Key") ? code.slice(3).toLowerCase() : code,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
    repeat: !!mods.repeat,
  } as KeyboardEvent;
}

describe("history storage", () => {
  beforeEach(() => clearHistory());

  it("keeps one entry per dictation, newest first", () => {
    pushTranscript("first thing I said", 1000);
    pushTranscript("second thing I said", 2000);
    expect(loadHistory().map((e) => e.text)).toEqual([
      "second thing I said",
      "first thing I said",
    ]);
  });

  it("ignores empty and whitespace-only transcriptions", () => {
    pushTranscript("   ", 1000);
    pushTranscript("", 2000);
    expect(loadHistory()).toEqual([]);
  });

  it("does not stack an immediate repeat, which is always a retry", () => {
    pushTranscript("say that again", 1000);
    pushTranscript("say that again", 2000);
    expect(loadHistory()).toHaveLength(1);
    // Only consecutive repeats collapse — the same phrase later is its own entry.
    pushTranscript("something else", 3000);
    pushTranscript("say that again", 4000);
    expect(loadHistory()).toHaveLength(3);
  });

  it("caps what it stores", () => {
    for (let i = 0; i < MAX_STORED + 20; i++)
      pushTranscript(`entry ${i}`, 1000 + i);
    const all = loadHistory();
    expect(all).toHaveLength(MAX_STORED);
    expect(all[0].text).toBe(`entry ${MAX_STORED + 19}`);
  });

  it("survives a corrupt store rather than taking dictation down with it", () => {
    localStorage.setItem("canopy.dictationHistory", "{not json");
    expect(loadHistory()).toEqual([]);
    expect(pushTranscript("still works", 1000).map((e) => e.text)).toEqual([
      "still works",
    ]);
  });

  it("reads ages in the past tense", () => {
    const now = 10_000_000_000;
    expect(timeAgo(now - 5_000, now)).toBe("just now");
    expect(timeAgo(now - 4 * 60_000, now)).toBe("4m ago");
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
});

describe("stillHolding", () => {
  it("is true only while every modifier the hotkey needs is down", () => {
    expect(stillHolding(key("KeyV", { meta: true, ctrl: true }), HOTKEY)).toBe(
      true,
    );
    expect(stillHolding(key("KeyV", { meta: true }), HOTKEY)).toBe(false);
    expect(stillHolding(key("KeyV", { ctrl: true }), HOTKEY)).toBe(false);
  });

  it("tolerates extra modifiers — only letting go matters", () => {
    expect(
      stillHolding(
        key("KeyV", { meta: true, ctrl: true, shift: true }),
        HOTKEY,
      ),
    ).toBe(true);
  });
});

describe("HistoryCycle", () => {
  let shown: { entries: TranscriptEntry[]; index: number } | null;
  let committed: TranscriptEntry | null;
  let dismissed: number;
  let store: TranscriptEntry[];
  let cycle: HistoryCycle;

  const entry = (text: string, at: number): TranscriptEntry => ({
    id: `id-${at}`,
    text,
    at,
  });

  beforeEach(() => {
    shown = null;
    committed = null;
    dismissed = 0;
    store = [
      entry("newest", 3000),
      entry("middle", 2000),
      entry("oldest", 1000),
    ];
    cycle = new HistoryCycle(
      {
        show: (entries, index) => {
          shown = { entries, index };
        },
        commit: (e) => {
          committed = e;
        },
        dismiss: () => {
          dismissed++;
        },
      },
      HOTKEY,
      () => store,
      (id) => (store = store.filter((e) => e.id !== id)),
    );
  });

  it("tap and let go pastes the latest — the common case costs no thought", () => {
    expect(
      cycle.keydown(key("KeyV", { meta: true, ctrl: true }), matchesHotkey),
    ).toBe(true);
    expect(shown).toMatchObject({ index: 0 });
    // Modifiers come up.
    cycle.keyup(key("MetaLeft", { ctrl: true }));
    expect(committed?.text).toBe("newest");
    expect(cycle.isOpen).toBe(false);
  });

  it("each further tap while held walks further back", () => {
    cycle.keydown(key("KeyV", { meta: true, ctrl: true }), matchesHotkey);
    cycle.keydown(key("KeyV", { meta: true, ctrl: true }), matchesHotkey);
    expect(shown).toMatchObject({ index: 1 });
    cycle.keydown(key("KeyV", { meta: true, ctrl: true }), matchesHotkey);
    expect(shown).toMatchObject({ index: 2 });
    cycle.keyup(key("MetaLeft", { ctrl: true }));
    expect(committed?.text).toBe("oldest");
  });

  it("does not spin on auto-repeat, but still swallows it", () => {
    cycle.keydown(key("KeyV", { meta: true, ctrl: true }), matchesHotkey);
    for (let i = 0; i < 20; i++) {
      expect(
        cycle.keydown(
          key("KeyV", { meta: true, ctrl: true, repeat: true }),
          matchesHotkey,
        ),
      ).toBe(true);
    }
    expect(shown).toMatchObject({ index: 0 });
  });

  it("wraps, so holding it down never dead-ends", () => {
    cycle.keydown(key("KeyV", { meta: true, ctrl: true }), matchesHotkey);
    for (let i = 0; i < 3; i++)
      cycle.keydown(key("KeyV", { meta: true, ctrl: true }), matchesHotkey);
    expect(shown).toMatchObject({ index: 0 });
  });

  it("shift walks the other way without releasing the chord", () => {
    cycle.keydown(key("KeyV", { meta: true, ctrl: true }), matchesHotkey);
    cycle.keydown(
      key("KeyV", { meta: true, ctrl: true, shift: true }),
      matchesHotkey,
    );
    expect(shown).toMatchObject({ index: 2 });
  });

  it("arrows move the selection for anyone who would rather look than tap", () => {
    cycle.keydown(key("KeyV", { meta: true, ctrl: true }), matchesHotkey);
    cycle.keydown(key("ArrowDown", { meta: true, ctrl: true }), matchesHotkey);
    expect(shown).toMatchObject({ index: 1 });
    cycle.keydown(key("ArrowUp", { meta: true, ctrl: true }), matchesHotkey);
    expect(shown).toMatchObject({ index: 0 });
  });

  it("Esc leaves without pasting", () => {
    cycle.keydown(key("KeyV", { meta: true, ctrl: true }), matchesHotkey);
    expect(
      cycle.keydown(key("Escape", { meta: true, ctrl: true }), matchesHotkey),
    ).toBe(true);
    expect(committed).toBeNull();
    expect(dismissed).toBe(1);
    // A release after Esc must not resurrect the paste.
    cycle.keyup(key("MetaLeft", {}));
    expect(committed).toBeNull();
  });

  it("Delete drops the highlighted entry and keeps cycling", () => {
    cycle.keydown(key("KeyV", { meta: true, ctrl: true }), matchesHotkey);
    cycle.keydown(key("Backspace", { meta: true, ctrl: true }), matchesHotkey);
    expect(store.map((e) => e.text)).toEqual(["middle", "oldest"]);
    expect(shown).toMatchObject({ index: 0 });
    cycle.keyup(key("MetaLeft", {}));
    expect(committed?.text).toBe("middle");
  });

  it("closes when the last entry is deleted", () => {
    store = [entry("only one", 1000)];
    cycle.keydown(key("KeyV", { meta: true, ctrl: true }), matchesHotkey);
    cycle.keydown(key("Delete", { meta: true, ctrl: true }), matchesHotkey);
    expect(cycle.isOpen).toBe(false);
    expect(dismissed).toBe(1);
    expect(committed).toBeNull();
  });

  it("does not swallow the key when there is nothing to paste", () => {
    store = [];
    expect(
      cycle.keydown(key("KeyV", { meta: true, ctrl: true }), matchesHotkey),
    ).toBe(false);
    expect(cycle.isOpen).toBe(false);
  });

  it("losing the window closes the picker without pasting", () => {
    cycle.keydown(key("KeyV", { meta: true, ctrl: true }), matchesHotkey);
    cycle.blur();
    expect(cycle.isOpen).toBe(false);
    expect(committed).toBeNull();
    expect(dismissed).toBe(1);
  });

  it("ignores keyup while closed", () => {
    cycle.keyup(key("MetaLeft", {}));
    expect(committed).toBeNull();
    expect(shown).toBeNull();
  });
});
