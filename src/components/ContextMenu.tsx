// Moved to shared/ContextMenu.tsx so the shared FileTree can use it without
// importing from src/. Re-exported here so every existing call site resolves
// unchanged — the move is a move, not a rename of eight files.
export * from "../../shared/ContextMenu";
