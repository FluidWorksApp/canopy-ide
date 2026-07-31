// Turning a tool's JSON Schema into a form, and the form's answers back into
// the JSON the server asked for.
//
// Kept out of the view because this is the part with rules in it. A schema is
// arbitrary JSON and the form is a handful of typed inputs, so something has to
// decide which properties get a control, which fall back to a JSON box, and how
// "42" typed into a text field becomes the number 42 — and that decision is
// worth testing without mounting a component.
//
// The form is deliberately partial. Anything it can't render a control for is
// still editable as raw JSON, because a form that silently drops a field would
// send a call the user didn't write.
import type { JsonSchema } from "./ipc";

/** A control the form knows how to draw. */
export type FieldKind = "string" | "text" | "number" | "boolean" | "enum" | "json";

export interface Field {
  name: string;
  kind: FieldKind;
  required: boolean;
  description?: string;
  /** `enum` only. */
  options?: string[];
  /** The schema's own default, pre-filled so a call can be made without
   *  re-typing what the server already suggested. */
  initial?: unknown;
  /** The raw sub-schema, for the detail panel to show alongside the control. */
  schema: JsonSchema;
}

/** The first named type, since schemas write `["string", "null"]` for optional
 *  as often as they write `"string"`. `null` is not a control. */
function primaryType(schema: JsonSchema): string {
  const t = schema.type;
  if (Array.isArray(t)) return t.find((x) => x !== "null") ?? "string";
  return typeof t === "string" ? t : "";
}

/** Long prose, an explicit multi-line format, or a name that says so: these get
 *  a textarea, because a one-line input for a code snippet or a commit message
 *  is the difference between usable and not. */
function wantsTextarea(name: string, schema: JsonSchema): boolean {
  if (schema.format === "textarea" || schema.format === "markdown") return true;
  return /body|content|text|message|prompt|query|code|script|html|markdown/i.test(
    name,
  );
}

function kindOf(name: string, schema: JsonSchema): FieldKind {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return "enum";
  switch (primaryType(schema)) {
    case "boolean":
      return "boolean";
    case "number":
    case "integer":
      return "number";
    case "string":
      return wantsTextarea(name, schema) ? "text" : "string";
    // Objects and arrays have no honest flat control. JSON is not a fallback
    // here so much as the correct editor for a nested value.
    default:
      return "json";
  }
}

/** The controls for one tool's arguments, in the schema's own order.
 *
 *  Property order is meaningful — servers list the important argument first —
 *  so it is preserved rather than sorted, except that required fields come
 *  first: they are what the user has to fill in to press Run. */
export function fieldsOf(schema: JsonSchema | null | undefined): Field[] {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object") return [];
  const required = new Set(
    Array.isArray(schema?.required) ? (schema.required as string[]) : [],
  );
  const fields = Object.entries(properties).map(([name, sub]) => {
    const child: JsonSchema = sub && typeof sub === "object" ? sub : {};
    const kind = kindOf(name, child);
    return {
      name,
      kind,
      required: required.has(name),
      description:
        typeof child.description === "string" ? child.description : undefined,
      options:
        kind === "enum"
          ? (child.enum as unknown[]).map((v) => String(v))
          : undefined,
      initial: child.default,
      schema: child,
    };
  });
  // Stable partition: required first, each group otherwise untouched.
  return [...fields.filter((f) => f.required), ...fields.filter((f) => !f.required)];
}

/** What a field starts out holding, as the string the input binds to. */
export function initialValue(field: Field): string {
  if (field.initial === undefined) return "";
  if (typeof field.initial === "string") return field.initial;
  return JSON.stringify(field.initial);
}

/** Every field's starting value, for a tool the user has just selected. */
export function initialValues(fields: Field[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) values[field.name] = initialValue(field);
  return values;
}

/** Which required fields are still empty. Run is disabled while this is
 *  non-empty — the server would reject the call anyway, and its error is a
 *  worse way to learn than a greyed-out button. */
export function missingRequired(
  fields: Field[],
  values: Record<string, string>,
): string[] {
  return fields
    .filter((f) => f.required && !(values[f.name] ?? "").trim())
    .map((f) => f.name);
}

/** The form's strings as the JSON the tool declared it wants.
 *
 *  Empty optional fields are omitted rather than sent as `""`: a server that
 *  distinguishes "absent" from "empty" — and many do, it is how optional
 *  filters work — must see absent. Malformed JSON in a json field is passed
 *  through as the string the user typed, so the server's own error names the
 *  field instead of the form silently rewriting it. */
export function toArguments(
  fields: Field[],
  values: Record<string, string>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.name] ?? "";
    if (!raw.trim() && !field.required) continue;
    switch (field.kind) {
      case "boolean":
        args[field.name] = raw === "true";
        break;
      case "number": {
        const n = Number(raw);
        args[field.name] = Number.isFinite(n) ? n : raw;
        break;
      }
      case "json":
        try {
          args[field.name] = JSON.parse(raw);
        } catch {
          args[field.name] = raw;
        }
        break;
      default:
        args[field.name] = raw;
    }
  }
  return args;
}

/** The tool's own risk hints, as short words to show next to its name.
 *
 *  Read-only is worth saying because it is the one that makes a tool safe to
 *  try; destructive is worth saying louder. A server that sets neither gets no
 *  badge rather than a guess. */
export function toolBadges(
  annotations: Record<string, unknown> | null | undefined,
): { label: string; tone: "ok" | "warn" | "dim" }[] {
  if (!annotations) return [];
  const badges: { label: string; tone: "ok" | "warn" | "dim" }[] = [];
  if (annotations.readOnlyHint === true)
    badges.push({ label: "read-only", tone: "ok" });
  if (annotations.destructiveHint === true)
    badges.push({ label: "destructive", tone: "warn" });
  if (annotations.openWorldHint === true)
    badges.push({ label: "external", tone: "dim" });
  return badges;
}

/** Whether running this tool should be confirmed first. Destructive is the
 *  server's own word for it, and a test call the user didn't think through is
 *  exactly what this panel makes easy to do by accident. */
export function needsConfirm(
  annotations: Record<string, unknown> | null | undefined,
): boolean {
  return annotations?.destructiveHint === true;
}

/** A tool call's answer as text.
 *
 *  Text blocks are joined; anything else is described rather than rendered —
 *  an image or an embedded resource is real content, and a line saying so beats
 *  either a blank panel or a screenful of base64. */
export function renderContent(
  content: { type: string; text?: string; mimeType?: string; uri?: string }[],
): string {
  if (!Array.isArray(content) || content.length === 0) return "";
  return content
    .map((block) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "image") return `[image${block.mimeType ? ` · ${block.mimeType}` : ""}]`;
      if (block.type === "resource" || block.type === "resource_link")
        return `[resource${block.uri ? ` · ${block.uri}` : ""}]`;
      return `[${block.type}]`;
    })
    .join("\n");
}
