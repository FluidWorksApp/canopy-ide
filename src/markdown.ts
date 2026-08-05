// The renderer itself lives in shared/markdown.ts so the remote portal renders
// the same sanitized HTML the desktop does — one sanctioned marked + DOMPurify
// pipeline for both shells, not a second one to drift. Desktop call sites keep
// importing from here; the module is the same one.
export * from "../shared/markdown";
