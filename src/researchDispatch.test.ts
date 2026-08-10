import { describe, expect, it, vi } from "vitest";
import { dispatchResearch } from "./researchDispatch";

describe("durable research dispatch", () => {
  it("creates the receipt before launching and opens it after acknowledgement", async () => {
    const order: string[] = [];
    const entry = { id: "0159-cognito-migration" };
    const result = await dispatchResearch({
      create: async () => {
        order.push("create");
        return entry;
      },
      link: async () => void order.push("link"),
      directory: async () => {
        order.push("directory");
        return "/research/0159";
      },
      launch: async () => {
        order.push("launch");
        return true;
      },
      block: async () => void order.push("block"),
      open: () => void order.push("open"),
    });
    expect(order).toEqual(["create", "link", "directory", "launch", "open"]);
    expect(result).toEqual({ entry, launched: true });
  });

  it("keeps a launch failure as a blocked, visible entry", async () => {
    const entry = { id: "0159-cognito-migration" };
    const block = vi.fn(async () => {});
    const open = vi.fn();
    const result = await dispatchResearch({
      create: async () => entry,
      directory: async () => "/research/0159",
      launch: async () => false,
      block,
      open,
    });
    expect(block).toHaveBeenCalledWith(entry);
    expect(open).toHaveBeenCalledWith(entry);
    expect(result.launched).toBe(false);
  });

  it("does not lose the receipt when setup throws after creation", async () => {
    const entry = { id: "0159-cognito-migration" };
    const failure = new Error("agent spawn failed");
    const block = vi.fn(async () => {});
    const open = vi.fn();
    const result = await dispatchResearch({
      create: async () => entry,
      directory: async () => {
        throw failure;
      },
      launch: async () => true,
      block,
      open,
    });
    expect(block).toHaveBeenCalledWith(entry, failure);
    expect(open).toHaveBeenCalledWith(entry);
    expect(result.error).toBe(failure);
  });

  it("rejects when no durable receipt could be created", async () => {
    const open = vi.fn();
    await expect(
      dispatchResearch({
        create: async () => {
          throw new Error("store unavailable");
        },
        directory: async () => "/research/0159",
        launch: async () => true,
        block: async () => {},
        open,
      }),
    ).rejects.toThrow("store unavailable");
    expect(open).not.toHaveBeenCalled();
  });
});
