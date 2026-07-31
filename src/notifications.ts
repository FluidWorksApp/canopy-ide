// Moved to shared/notifications.ts, which both shells import: the desktop from
// here, the portal as `@shared/notifications`. Kept as a re-export so every
// existing `from "./notifications"` still resolves and the move stays a move
// rather than a rename of forty call sites.
export * from "../shared/notifications";
