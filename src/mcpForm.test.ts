import { describe, expect, it } from "vitest";
import {
  fieldsOf,
  initialValues,
  missingRequired,
  needsConfirm,
  renderContent,
  toArguments,
  toolBadges,
} from "./mcpForm";

// A tool's schema is arbitrary JSON written by someone else, and the form has to
// make a call out of it that the server accepts. These cover the decisions in
// between: which control a property gets, and what the strings the user typed
// become on the way out.

describe("choosing a control", () => {
  it("gives each JSON type the control that fits it", () => {
    const fields = fieldsOf({
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "integer" },
        deep: { type: "boolean" },
        mode: { type: "string", enum: ["fast", "slow"] },
        filters: { type: "object" },
        tags: { type: "array" },
      },
    });
    const kinds = Object.fromEntries(fields.map((f) => [f.name, f.kind]));
    expect(kinds).toEqual({
      name: "string",
      count: "number",
      deep: "boolean",
      mode: "enum",
      filters: "json",
      tags: "json",
    });
  });

  // `["string", "null"]` is how half the servers in the wild spell "optional".
  // Read as a single type it is neither, and the field falls to a JSON box.
  it("reads a nullable type as the type it actually is", () => {
    const [field] = fieldsOf({
      type: "object",
      properties: { note: { type: ["string", "null"] } },
    });
    expect(field.kind).toBe("string");
  });

  it("gives prose a textarea rather than a one-line input", () => {
    const fields = fieldsOf({
      type: "object",
      properties: { body: { type: "string" }, slug: { type: "string" } },
    });
    expect(fields.find((f) => f.name === "body")?.kind).toBe("text");
    expect(fields.find((f) => f.name === "slug")?.kind).toBe("string");
  });

  // What you have to fill in to press Run should not be below the fold.
  it("puts the required arguments first without reordering within a group", () => {
    const fields = fieldsOf({
      type: "object",
      properties: {
        alpha: { type: "string" },
        beta: { type: "string" },
        gamma: { type: "string" },
      },
      required: ["gamma"],
    });
    expect(fields.map((f) => f.name)).toEqual(["gamma", "alpha", "beta"]);
  });

  it("treats a tool with no schema as a tool with no arguments", () => {
    expect(fieldsOf(null)).toEqual([]);
    expect(fieldsOf({ type: "object" })).toEqual([]);
  });

  it("starts a field on the schema's own default", () => {
    const fields = fieldsOf({
      type: "object",
      properties: {
        limit: { type: "integer", default: 25 },
        q: { type: "string", default: "hello" },
      },
    });
    expect(initialValues(fields)).toEqual({ limit: "25", q: "hello" });
  });
});

describe("what gets sent", () => {
  const fields = fieldsOf({
    type: "object",
    properties: {
      q: { type: "string" },
      limit: { type: "integer" },
      deep: { type: "boolean" },
      filters: { type: "object" },
    },
    required: ["q"],
  });

  it("sends numbers as numbers and booleans as booleans, not as strings", () => {
    const args = toArguments(fields, {
      q: "canopy",
      limit: "25",
      deep: "true",
      filters: "",
    });
    expect(args).toEqual({ q: "canopy", limit: 25, deep: true });
  });

  // A server that distinguishes "absent" from "empty" — which is how optional
  // filters work — must see absent, not "".
  it("omits an optional field the user left blank", () => {
    const args = toArguments(fields, { q: "x", limit: "", deep: "", filters: "" });
    expect(Object.keys(args)).toEqual(["q"]);
  });

  it("parses a JSON field into real JSON", () => {
    const args = toArguments(fields, { q: "x", filters: '{"open": true}' });
    expect(args.filters).toEqual({ open: true });
  });

  // Rewriting it would hide the mistake; sending it lets the server's own
  // error name the field.
  it("sends malformed JSON as typed rather than silently dropping it", () => {
    const args = toArguments(fields, { q: "x", filters: "{oops" });
    expect(args.filters).toBe("{oops");
  });

  it("names the required fields still to be filled in", () => {
    expect(missingRequired(fields, { q: "  " })).toEqual(["q"]);
    expect(missingRequired(fields, { q: "x" })).toEqual([]);
  });
});

describe("what the server says about a tool", () => {
  it("marks read-only and destructive tools from their hints", () => {
    expect(toolBadges({ readOnlyHint: true })).toEqual([
      { label: "read-only", tone: "ok" },
    ]);
    expect(toolBadges({ destructiveHint: true, openWorldHint: true })).toEqual([
      { label: "destructive", tone: "warn" },
      { label: "external", tone: "dim" },
    ]);
  });

  it("guesses nothing about a tool that carries no hints", () => {
    expect(toolBadges(null)).toEqual([]);
    expect(toolBadges({})).toEqual([]);
    expect(needsConfirm(null)).toBe(false);
  });

  it("asks before running what the server calls destructive", () => {
    expect(needsConfirm({ destructiveHint: true })).toBe(true);
    expect(needsConfirm({ readOnlyHint: true })).toBe(false);
  });
});

describe("showing an answer", () => {
  it("joins text blocks and describes the ones it cannot show", () => {
    const text = renderContent([
      { type: "text", text: "first" },
      { type: "image", mimeType: "image/png" },
      { type: "resource", uri: "file:///tmp/a.txt" },
      { type: "text", text: "last" },
    ]);
    expect(text).toBe(
      "first\n[image · image/png]\n[resource · file:///tmp/a.txt]\nlast",
    );
  });

  it("has nothing to say about an empty answer", () => {
    expect(renderContent([])).toBe("");
  });
});
