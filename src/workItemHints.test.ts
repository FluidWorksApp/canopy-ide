import { describe, expect, it } from "vitest";
import {
  applyHints,
  buildWorkItemDigest,
  parseHintsReply,
  type WorkItemHints,
} from "./workItemHints";

describe("parseHintsReply", () => {
  it("reads a bare JSON object", () => {
    const hints = parseHintsReply(
      '{"labels": {"s1": "Waze API reuse"}, "assign": [{"tabId": "f1", "key": "s1", "confidence": 0.9}]}',
    );
    expect(hints).toEqual({
      labels: { s1: "Waze API reuse" },
      assign: [{ tabId: "f1", key: "s1", confidence: 0.9 }],
    });
  });

  it("survives prose and fences around the JSON", () => {
    const hints = parseHintsReply(
      'Sure! Here you go:\n```json\n{"labels": {"s1": "Portal payload trim"}}\n```\nLet me know…',
    );
    expect(hints?.labels).toEqual({ s1: "Portal payload trim" });
  });

  it("drops malformed entries field-by-field", () => {
    const hints = parseHintsReply(
      JSON.stringify({
        labels: { s1: "ok", s2: 7, s3: "   " },
        assign: [
          { tabId: "a", key: "s1", confidence: 0.9 },
          { tabId: "b", key: "s1", confidence: 1.5 },
          { tabId: "c", confidence: 0.9 },
          "junk",
        ],
      }),
    );
    expect(hints).toEqual({
      labels: { s1: "ok" },
      assign: [{ tabId: "a", key: "s1", confidence: 0.9 }],
    });
  });

  it("clamps runaway labels", () => {
    const hints = parseHintsReply(JSON.stringify({ labels: { k: "x".repeat(200) } }));
    expect(hints?.labels.k).toHaveLength(48);
  });

  it("is null for no JSON, bad JSON, or nothing usable", () => {
    expect(parseHintsReply("no json here")).toBeNull();
    expect(parseHintsReply("{broken")).toBeNull();
    expect(parseHintsReply('{"labels": {}, "assign": []}')).toBeNull();
  });
});

describe("applyHints", () => {
  const groups = () => [
    { key: "s1", ids: ["s1", "ws1"] },
    { key: "f1", ids: ["f1"] },
    { key: "sh1", ids: ["sh1"] },
  ];
  const hint = (tabId: string, key: string, confidence = 0.9): WorkItemHints => ({
    labels: {},
    assign: [{ tabId, key, confidence }],
  });

  it("homes a loose tab into an existing item", () => {
    const out = applyHints(groups(), hint("f1", "s1"));
    expect(out).toEqual([
      { key: "s1", ids: ["s1", "ws1", "f1"] },
      { key: "sh1", ids: ["sh1"] },
    ]);
  });

  it("never moves below the confidence bar", () => {
    expect(applyHints(groups(), hint("f1", "s1", 0.5))).toEqual(groups());
  });

  it("never moves a tab an edge already placed", () => {
    expect(applyHints(groups(), hint("ws1", "sh1"))).toEqual(groups());
  });

  it("never moves what the caller marks immovable", () => {
    const out = applyHints(groups(), hint("sh1", "s1"), (id) => id !== "sh1");
    expect(out).toEqual(groups());
  });

  it("ignores hints at unknown targets and self-assignments", () => {
    expect(applyHints(groups(), hint("f1", "nope"))).toEqual(groups());
    expect(applyHints(groups(), hint("f1", "f1"))).toEqual(groups());
  });
});

describe("buildWorkItemDigest", () => {
  it("is stable and readable", () => {
    const digest = buildWorkItemDigest(
      [
        { key: "s1", ids: ["s1", "pr1"] },
        { key: "f1", ids: ["f1"] },
      ],
      (id) => `<${id}>`,
    );
    expect(digest).toBe("item s1\n  s1: <s1>\n  pr1: <pr1>\nitem f1\n  f1: <f1>");
  });
});
