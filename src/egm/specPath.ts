// Where Elephant-Goldfish specs live. Kept apart from egmWorkflow.ts so the
// research module can recognise a spec without pulling in the bundled personas.

/** A spec's home: `docs/designs/<slug>.md`, the convention EGM and its users
 *  share. Derived from the research title so the same entry always lands on
 *  the same file. */
export function specPathFor(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `docs/designs/${slug || "feature"}.md`;
}

/** Is this linked file an EGM-style spec? Used to tell the implementer about it. */
export const isDesignSpec = (path: string): boolean =>
  /(^|[\\/])docs[\\/]designs[\\/][^\\/]+\.md$/i.test(path);
