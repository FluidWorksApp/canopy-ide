// Moved to shared/fuzzy.ts so the shared ContextMenu can rank its own rows
// without importing from src/. Re-exported here so every existing call site
// resolves unchanged — the move is a move, not a rename of four files.
export * from "../shared/fuzzy";
