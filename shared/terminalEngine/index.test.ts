import { beforeAll, describe, expect, it } from "vitest";
import { createTerminal, ghosttyFailure, liveStats, type CreatedTerminal } from "./index";
import { resetGhosttyStateForTests } from "./ghostty/engine";
import { loadEngineForTests } from "./testEngine";

const parsed = (created: CreatedTerminal, data: string | Uint8Array = "") =>
  new Promise<void>((resolve) => created.term.write(data, resolve));

function lines(created: CreatedTerminal): string[] {
  const buffer = created.term.buffer.active;
  const out: string[] = [];
  // xterm keeps a written trailing blank where Ghostty trims it: the same
  // screen either way.
  for (let i = 0; i < buffer.length; i++) out.push(buffer.getLine(i)!.translateToString(true).trimEnd());
  return out;
}

/** Make the engine under a Ghostty terminal trap on its next `count` parses. */
function breakEngine(created: CreatedTerminal, count: number): void {
  const ghostty = (created.term as unknown as { ghostty: { wasm: { advance(b: Uint8Array): void } } })
    .ghostty;
  let left = count;
  const patch = () => {
    const engine = ghostty.wasm;
    const real = engine.advance.bind(engine);
    engine.advance = (bytes: Uint8Array) => {
      if (left > 0) {
        left--;
        throw new WebAssembly.RuntimeError("unreachable");
      }
      real(bytes);
    };
  };
  patch();
  // The rebuilt engine is a new object: break that one too.
  const original = Object.getOwnPropertyDescriptor(ghostty, "wasm");
  let current = ghostty.wasm;
  Object.defineProperty(ghostty, "wasm", {
    configurable: true,
    get: () => current,
    set: (value) => {
      current = value;
      if (value && left > 0) patch();
    },
  });
  void original;
}

describe("createTerminal", () => {
  it("uses xterm, and says why, while the engine is not loaded", async () => {
    const created = createTerminal({ engine: "ghostty", scrollback: 100 });
    expect(created.engine).toBe("xterm");
    expect(created.fallback).toBe("not-loaded");
    await parsed(created, "hello");
    expect(lines(created)[0]).toBe("hello");
    expect(created.stats.bytes).toBe(5);
    expect(liveStats()).toContain(created.stats);
    created.term.dispose();
    expect(liveStats()).not.toContain(created.stats);
  });

  describe("with the engine loaded", () => {
    beforeAll(loadEngineForTests);

    it("runs on Ghostty by default and on xterm when chosen", async () => {
      const ours = createTerminal({ engine: "ghostty", scrollback: 100 });
      const classic = createTerminal({ engine: "xterm", scrollback: 100 });
      expect([ours.engine, ours.fallback]).toEqual(["ghostty", ""]);
      expect([classic.engine, classic.fallback]).toEqual(["xterm", ""]);
      await parsed(ours, "one\r\ntwo");
      await parsed(classic, "one\r\ntwo");
      expect(lines(ours).slice(0, 2)).toEqual(lines(classic).slice(0, 2));
      ours.term.dispose();
      classic.term.dispose();
    });

    it("restores a Ghostty terminal's state on xterm and the other way round", async () => {
      const stream =
        Array.from({ length: 40 }, (_, i) => `\x1b[3${i % 8}mrow ${i}\x1b[0m\r\n`).join("") +
        "\x1b[1;4mprompt\x1b[0m> \x1b[?2004h\x1b[?1000h\x1b[?1006h";
      const options = { scrollback: 100 } as const;
      const ours = createTerminal({ engine: "ghostty", ...options });
      const classic = createTerminal({ engine: "xterm", ...options });
      for (const t of [ours, classic]) t.term.resize(30, 8);
      await parsed(ours, stream);
      await parsed(classic, stream);

      const onClassic = createTerminal({ engine: "xterm", ...options });
      onClassic.term.resize(30, 8);
      await parsed(onClassic, ours.mouseModes.serialize(ours.serializer, { scrollback: 100 }));
      expect(lines(onClassic)).toEqual(lines(ours));
      expect(onClassic.term.modes.mouseTrackingMode).toBe("vt200");

      const onOurs = createTerminal({ engine: "ghostty", ...options });
      onOurs.term.resize(30, 8);
      await parsed(onOurs, classic.mouseModes.serialize(classic.serializer, { scrollback: 100 }));
      expect(lines(onOurs)).toEqual(lines(classic));
      expect(onOurs.term.modes.mouseTrackingMode).toBe("vt200");
      for (const t of [ours, classic, onClassic, onOurs]) t.term.dispose();
    });

    it("carries a tab over to xterm when the engine cannot be repaired", async () => {
      const created = createTerminal({ engine: "ghostty", scrollback: 100 });
      const sent: string[] = [];
      const titles: string[] = [];
      const osc: string[] = [];
      const failures: string[] = [];
      created.term.onData((data) => sent.push(data));
      created.term.onTitleChange((title) => titles.push(title));
      created.term.parser.registerOscHandler(9, (data) => (osc.push(data), true));
      created.onEngineFailure((reason) => failures.push(reason));
      await parsed(created, "kept line\r\n");

      // One trap is repaired in place; a second one straight away is not.
      breakEngine(created, 2);
      let called = 0;
      created.term.write("lost? ", () => called++);
      created.term.write("no\x1b[6n", () => called++);
      await parsed(created);
      await parsed(created);

      expect(created.engine).toBe("xterm");
      expect(created.fallback).toBe("engine-trap");
      expect(created.stats.engine).toBe("xterm");
      expect(ghosttyFailure()).toBe("engine-trap");
      expect(called).toBe(2);
      expect(failures).toEqual([]);
      expect(lines(created).slice(0, 2)).toEqual(["kept line", "lost? no"]);
      // The query in the replayed output was answered once, not twice.
      expect(sent.filter((d) => d.endsWith("R"))).toHaveLength(1);

      // Everything registered before the switch still works after it.
      await parsed(created, "\x1b]0;after\x07\x1b]9;ping\x07");
      expect(titles).toContain("after");
      expect(osc).toEqual(["ping"]);
      created.term.input("typed");
      expect(sent).toContain("typed");
      expect(created.serializer.serialize()).toContain("kept line");

      // A terminal opened after a failure starts on xterm.
      const next = createTerminal({ engine: "ghostty", scrollback: 100 });
      expect([next.engine, next.fallback]).toEqual(["xterm", "engine-trap"]);
      next.term.dispose();
      created.term.dispose();
      resetGhosttyStateForTests();
    });
  });
});
