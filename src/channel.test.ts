// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createChannel, useChannel, useChannelSelect } from "./channel";

describe("createChannel", () => {
  it("holds a value and notifies on change", () => {
    const ch = createChannel(1);
    const heard: number[] = [];
    ch.subscribe(() => heard.push(ch.get()));
    ch.set(2);
    ch.set(3);
    expect(ch.get()).toBe(3);
    expect(heard).toEqual([2, 3]);
  });

  it("skips writes `same` says are unchanged — including the default Object.is", () => {
    const ch = createChannel(1);
    const spy = vi.fn();
    ch.subscribe(spy);
    ch.set(1);
    expect(spy).not.toHaveBeenCalled();

    const deep = createChannel(
      { a: 1, b: 1 },
      { same: (x, y) => x.a === y.a && x.b === y.b },
    );
    const deepSpy = vi.fn();
    deep.subscribe(deepSpy);
    deep.set({ a: 1, b: 1 });
    expect(deepSpy).not.toHaveBeenCalled();
    deep.set({ a: 1, b: 2 });
    expect(deepSpy).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing listener from the ones after it", () => {
    const ch = createChannel(0);
    const after = vi.fn();
    ch.subscribe(() => {
      throw new Error("subscriber bug");
    });
    ch.subscribe(after);
    ch.set(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("survives a listener unsubscribing mid-notify", () => {
    const ch = createChannel(0);
    const heard: string[] = [];
    const un = ch.subscribe(() => {
      heard.push("a");
      un();
    });
    ch.subscribe(() => heard.push("b"));
    ch.set(1);
    ch.set(2);
    expect(heard).toEqual(["a", "b", "b"]);
  });

  it("fires onActive on every 0→1 and onIdle on every 1→0", () => {
    const onActive = vi.fn();
    const onIdle = vi.fn();
    const ch = createChannel(0, { onActive, onIdle });
    const un1 = ch.subscribe(() => {});
    const un2 = ch.subscribe(() => {});
    expect(onActive).toHaveBeenCalledTimes(1);
    un1();
    expect(onIdle).not.toHaveBeenCalled();
    un2();
    expect(onIdle).toHaveBeenCalledTimes(1);
    // Double-unsubscribe must not fire onIdle again.
    un2();
    expect(onIdle).toHaveBeenCalledTimes(1);
    ch.subscribe(() => {});
    expect(onActive).toHaveBeenCalledTimes(2);
  });

  it("reset returns the initial value and forgets every listener", () => {
    const ch = createChannel("start");
    const spy = vi.fn();
    ch.subscribe(spy);
    ch.set("moved");
    ch.reset();
    expect(ch.get()).toBe("start");
    ch.set("again");
    expect(spy).toHaveBeenCalledTimes(1); // only the pre-reset write
  });
});

describe("useChannel", () => {
  it("re-renders on writes and reads the current value", () => {
    const ch = createChannel(1);
    const { result } = renderHook(() => useChannel(ch));
    expect(result.current).toBe(1);
    act(() => ch.set(5));
    expect(result.current).toBe(5);
  });

  it("useChannelSelect only re-renders when the derived value changes", () => {
    const ch = createChannel({ n: 1, flag: false });
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useChannelSelect(ch, (v) => v.flag);
    });
    expect(result.current).toBe(false);
    const before = renders;
    act(() => ch.set({ n: 2, flag: false }));
    expect(renders).toBe(before); // n changed, flag didn't — no render
    act(() => ch.set({ n: 3, flag: true }));
    expect(result.current).toBe(true);
  });
});
